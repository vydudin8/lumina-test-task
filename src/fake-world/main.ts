import { createLogger } from '#server/log.ts'
import { serve } from '@hono/node-server'
import { createFakeWorld } from './app.ts'

const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' }).child({ service: 'fake-world' })
const port = Number(process.env.FAKE_WORLD_PORT ?? 4000)

serve({ fetch: createFakeWorld().fetch, port }, () => log.info({ port }, 'fake-world listening'))
