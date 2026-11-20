import { createFakeWorld, type FakeWorldOptions } from '#fake-world/app.ts'
import type { Fetch } from '../pipeline/ingest/fetch.ts'

// Rejects when the signal aborts, as a real fetch would; in-process handlers do not watch the signal themselves.
function abortable<T>(promise: Promise<T>, signal: AbortSignal | null | undefined) {
	if (!signal) return promise
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			if (signal.aborted) reject(signal.reason as Error)
			signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
		}),
	])
}

export const TEST_WEBHOOK_SECRET = 'test-webhook-secret'

export function testWorld(options: FakeWorldOptions = {}) {
	const world = createFakeWorld({
		controls: true,
		appUrl: 'http://app',
		webhookSecret: TEST_WEBHOOK_SECRET,
		timeoutDelayMs: 200,
		returnedRate: 0,
		sleep: () => Promise.resolve(),
		deliver: () => Promise.resolve(new Response('ok')),
		...options,
	})
	const fetch: Fetch = (input, init) =>
		abortable(Promise.resolve(world.app.fetch(new Request(input, init))), init?.signal)
	const control = (body: Record<string, unknown>) =>
		world.app.fetch(
			new Request('http://fake/__control', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		)
	const calls = async () =>
		(await (await world.app.fetch(new Request('http://fake/__calls'))).json()) as {
			submissions: { cardId: number }[]
			postcards: { id: string; cardId: number }[]
		}
	return { ...world, fetch, control, calls }
}
