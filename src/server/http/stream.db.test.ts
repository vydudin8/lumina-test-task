import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { seed } from '../seed/seed.ts'
import { call, createTestApp, createTestHub, loginAs, type FetchApp } from '../test/app.ts'
import { useTestDb } from '../test/db.ts'

const now = new Date('2026-11-20T12:00:00Z')

describe('GET /api/stream', () => {
	const t = useTestDb()
	const hub = createTestHub()
	let app: FetchApp
	let cookie: string

	beforeAll(async () => {
		await seed(t.db, { now })
		app = createTestApp(t.db, { hub })
		cookie = await loginAs(app, 'usr_rep_tom')
	})

	afterEach(() => void vi.useRealTimers())

	it('needs a signed-in user', async () => {
		const response = await call(app, '/api/stream')
		expect(response.status).toBe(401)
		expect(hub.size).toBe(0)
	})

	it('streams each hub payload as a change event and unsubscribes when the client leaves', async () => {
		const response = await call(app, '/api/stream', { cookie })
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('text/event-stream')
		expect(response.headers.get('cache-control')).toBe('no-cache')
		expect(hub.size).toBe(1)

		hub.publish('campaign:7')
		const reader = response.body!.getReader()
		expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: change\ndata: campaign:7\n\n')

		await reader.cancel()
		await vi.waitFor(() => expect(hub.size).toBe(0))
	})

	it('sends a comment every 25 seconds so proxies keep the connection open', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
		const response = await call(app, '/api/stream', { cookie })
		const reader = response.body!.getReader()

		vi.advanceTimersByTime(25_000)
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(': heartbeat\n\n')
		await reader.cancel()
	})
})
