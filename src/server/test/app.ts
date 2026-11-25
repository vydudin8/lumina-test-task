import { createApp, type AppDeps } from '../app.ts'
import type { Db } from '../db/client.ts'
import { createStubLlm } from '../llm/stub.ts'
import { createLogger } from '../log.ts'
import type { Hub, Listener } from '../realtime.ts'
import { TEST_WEBHOOK_SECRET, testWorld } from './world.ts'

// A hub with no Postgres behind it: a test pushes payloads by hand.
export function createTestHub() {
	const listeners = new Set<Listener>()
	return {
		subscribe: (listener: Listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		publish: (payload: string) => listeners.forEach((listener) => listener(payload)),
		get size() {
			return listeners.size
		},
	} satisfies Hub & { publish: (payload: string) => void; size: number }
}

export const TEST_SESSION_SECRET = 'test-secret-0123456789abcdef0123456789'

// Providers are served in-process by fake-world; retries do not really sleep.
export function testDeps(db: Db, overrides: Partial<AppDeps> = {}): AppDeps {
	const world = testWorld()
	return {
		db,
		log: createLogger({ level: process.env.TEST_LOG_LEVEL ?? 'silent' }),
		sessionSecret: TEST_SESSION_SECRET,
		clock: () => new Date(),
		providerBaseUrl: 'http://fake-world',
		fetch: world.fetch,
		retry: { rng: () => 0.5, sleep: () => Promise.resolve() },
		llm: createStubLlm({ hallucinateEvery: 0 }),
		mail: { baseUrl: 'http://fake-world', fetch: world.fetch, timeoutMs: 50 },
		webhookSecret: TEST_WEBHOOK_SECRET,
		hub: createTestHub(),
		...overrides,
	}
}

export function createTestApp(db: Db, overrides: Partial<AppDeps> = {}) {
	return createApp(testDeps(db, overrides))
}

export interface FetchApp {
	fetch: (request: Request) => Response | Promise<Response>
}

interface CallOptions {
	method?: string
	body?: unknown
	cookie?: string
	headers?: Record<string, string>
}

export function call(app: FetchApp, path: string, { method = 'GET', body, cookie, headers }: CallOptions = {}) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: {
				// Browsers send Origin on every non-GET request; the CSRF guard relies on it.
				Origin: 'http://localhost',
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				...(cookie ? { Cookie: cookie } : {}),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	)
}

// "name=value" from a Set-Cookie header, ready to send back as Cookie.
export function cookieFrom(response: Response) {
	return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

export async function loginAs(app: FetchApp, userId: string) {
	return cookieFrom(await call(app, '/api/session', { method: 'PUT', body: { userId } }))
}
