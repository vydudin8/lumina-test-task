import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppDeps } from '../app.ts'
import { requireUser, type AppEnv } from './session.ts'

const HEARTBEAT_MS = 25_000

// Server-sent events: one open request per browser tab. A payload carries only an id, never data, so the client
// refetches through the normal, authorised API.
export function streamRoutes({ hub }: Pick<AppDeps, 'hub'>) {
	return new Hono<AppEnv>().get('/stream', requireUser, (context) => {
		// Reverse proxies such as nginx hold a response back until it fills a buffer, unless told not to.
		context.header('X-Accel-Buffering', 'no')
		return streamSSE(context, async (stream) => {
			const unsubscribe = hub.subscribe((payload) => void stream.writeSSE({ event: 'change', data: payload }))
			const heartbeat = setInterval(() => void stream.write(': heartbeat\n\n'), HEARTBEAT_MS)
			// Returning would close the response, so wait here until the client goes away.
			await new Promise<void>((resolve) =>
				stream.onAbort(() => {
					unsubscribe()
					clearInterval(heartbeat)
					resolve()
				}),
			)
		})
	})
}
