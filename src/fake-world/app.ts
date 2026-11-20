import { Hono } from 'hono'
import { loadProviderFixtures } from './fixtures.ts'
import { providerRoutes } from './providers.ts'

export function createFakeWorld() {
	const state = { rateLimited: new Set<string>() }
	const app = new Hono()

	app.get('/health', (context) => context.json({ status: 'ok' }))
	app.route('/', providerRoutes(loadProviderFixtures(), state))

	return app
}
