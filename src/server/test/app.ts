import { createApp } from '../app.ts'
import type { Db } from '../db/client.ts'
import { createLogger } from '../log.ts'

export const TEST_SESSION_SECRET = 'test-secret-0123456789abcdef0123456789'

export function createTestApp(db: Db) {
	return createApp({
		db,
		log: createLogger({ level: process.env.TEST_LOG_LEVEL ?? 'silent' }),
		sessionSecret: TEST_SESSION_SECRET,
	})
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
