import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp, type AppDeps } from './app.ts'
import { loadConfig } from './config.ts'
import { createDb } from './db/client.ts'
import { systemClock } from './lib/clock.ts'
import { createClaudeLlm } from './llm/claude.ts'
import { createStubLlm } from './llm/stub.ts'
import { createLogger } from './log.ts'
import { startSendWorker } from './pipeline/send/store.ts'

const config = loadConfig()
const log = createLogger({ level: config.LOG_LEVEL })
const db = createDb(config.DATABASE_URL, (error) =>
	log.warn({ cause: error.message }, 'database connection lost; reconnecting on the next query'),
)
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

process.once('SIGTERM', () => {
	sendWorker.stop()
	server.close(() => void db.$client.end())
})
