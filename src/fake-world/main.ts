import { createLogger } from '#server/log.ts'
import { serve } from '@hono/node-server'
import { createFakeWorld } from './app.ts'

const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' }).child({ service: 'fake-world' })
const port = Number(process.env.FAKE_WORLD_PORT ?? 4000)

const world = createFakeWorld({
	appUrl: process.env.APP_URL ?? 'http://localhost:3000',
	webhookSecret: process.env.MAIL_WEBHOOK_SECRET ?? 'dev-webhook-secret',
	controls: process.env.FAKE_WORLD_CONTROLS === '1',
})

serve({ fetch: world.app.fetch, port }, () =>
	log.info({ port, controls: process.env.FAKE_WORLD_CONTROLS === '1' }, 'fake-world listening'),
)
