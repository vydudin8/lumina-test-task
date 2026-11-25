import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp, type AppDeps } from './app.ts'
import { loadConfig } from './config.ts'
import { createDb } from './db/client.ts'
import { jobRunnerDeps } from './job-handlers.ts'
import { startJobRunner } from './jobs.ts'
import { systemClock } from './lib/clock.ts'
import { createClaudeLlm } from './llm/claude.ts'
import { createStubLlm } from './llm/stub.ts'
import { createLogger } from './log.ts'
import { startMailReconciler, startSendWorker } from './pipeline/send/store.ts'
import { createHub } from './realtime.ts'

const config = loadConfig()
const log = createLogger({ level: config.LOG_LEVEL })
const db = createDb(config.DATABASE_URL, (error) =>
	log.warn({ cause: error.message }, 'database connection lost; reconnecting on the next query'),
)
const hub = createHub({ url: config.DATABASE_URL, log: log.child({ job: 'hub' }) })
const deps: AppDeps = {
	db,
	log,
	sessionSecret: config.SESSION_SECRET,
	clock: systemClock,
	providerBaseUrl: config.FAKE_WORLD_URL,
	fetch: (input, init) => fetch(input, init),
	retry: {},
	mail: {
		baseUrl: config.MAIL_API_URL ?? config.FAKE_WORLD_URL,
		fetch: (input, init) => fetch(input, init),
		timeoutMs: config.MAIL_TIMEOUT_MS,
	},
	webhookSecret: config.MAIL_WEBHOOK_SECRET,
	hub,
	llm: config.ANTHROPIC_API_KEY
		? createClaudeLlm({ apiKey: config.ANTHROPIC_API_KEY, model: config.LLM_MODEL })
		: createStubLlm(),
}
const app = createApp(deps)

app.all('/api/*', (context) => context.json({ error: 'Not found' }, 404))
// The built React app; unknown paths get index.html so client-side routes survive a reload.
app.use('/*', serveStatic({ root: './dist/client' }))
app.get('*', serveStatic({ path: './dist/client/index.html' }))

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => log.info({ port }, 'app listening'))

const sendWorker = startSendWorker({
	db,
	log: log.child({ job: 'send-worker' }),
	clock: systemClock,
	mail: deps.mail,
	retry: {},
})
const jobRunner = startJobRunner(jobRunnerDeps(deps))
const mailReconciler = startMailReconciler(
	{ db, log: log.child({ job: 'mail-reconciler' }), clock: systemClock, mail: deps.mail, retry: {} },
	{
		intervalMs: config.MAIL_RECONCILE_INTERVAL_MS,
		batch: config.MAIL_RECONCILE_BATCH,
		staleAfterMs: config.MAIL_RECONCILE_STALE_MS,
	},
)

// The database closes last: the card being sent commits, a lines job stops after its batch and is queued again, and
// a request in progress gets its answer. Keep the platform's stop timeout above that (45 s in docker-compose.yml);
// a card still waiting on mail retries past it is rolled back by the kill and sent again with the same key.
process.once('SIGTERM', () => {
	log.info('shutting down')
	sendWorker.stop()
	mailReconciler.stop()
	jobRunner.stop()
	void hub.close()
	const closed = new Promise((resolve) => server.close(resolve))
	// Event streams never finish by themselves: give plain requests a moment, then drop the rest. Browsers reconnect.
	setTimeout(() => 'closeAllConnections' in server && server.closeAllConnections(), 5000).unref()
	void Promise.all([closed, sendWorker.done, mailReconciler.done, jobRunner.done])
		.then(() => db.$client.end())
		.then(() => log.info('shut down'))
})
