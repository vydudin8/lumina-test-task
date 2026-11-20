import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createDb } from './db/client.ts'
import { systemClock } from './lib/clock.ts'
import { createLogger } from './log.ts'

const config = loadConfig()
const log = createLogger({ level: config.LOG_LEVEL })
const db = createDb(config.DATABASE_URL)
const app = createApp({
	db,
	log,
	sessionSecret: config.SESSION_SECRET,
	clock: systemClock,
	providerBaseUrl: config.FAKE_WORLD_URL,
	fetch: (input, init) => fetch(input, init),
	retry: {},
})

app.all('/api/*', (context) => context.json({ error: 'Not found' }, 404))
// The built React app; unknown paths get index.html so client-side routes survive a reload.
app.use('/*', serveStatic({ root: './dist/client' }))
app.get('*', serveStatic({ path: './dist/client/index.html' }))

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => log.info({ port }, 'app listening'))

process.once('SIGTERM', () => {
	server.close(() => void db.$client.end())
})
