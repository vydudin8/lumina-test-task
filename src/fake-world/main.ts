import { createLogger } from '#server/log.ts'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' }).child({ service: 'fake-world' })
const port = Number(process.env.FAKE_WORLD_PORT ?? 4000)

const app = new Hono()
app.get('/health', (context) => context.json({ status: 'ok' }))

serve({ fetch: app.fetch, port }, () => log.info({ port }, 'fake-world listening'))
