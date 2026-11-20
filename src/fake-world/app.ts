import { Hono } from 'hono'
import { loadProviderFixtures } from './fixtures.ts'
import { mailRoutes, type MailOptions } from './mail.ts'
import { providerRoutes } from './providers.ts'

export type FakeWorldOptions = Partial<MailOptions>

export function createFakeWorld(options: FakeWorldOptions = {}) {
	const state = { rateLimited: new Set<string>() }
	const mail = mailRoutes({
		appUrl: 'http://localhost:3000',
		webhookSecret: 'dev-webhook-secret',
		deliver: (request) => fetch(request),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		stall: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		rng: Math.random,
		now: () => new Date(),
		timeoutDelayMs: 5000,
		returnedRate: 0.1,
		controls: false,
		...options,
	})
	const app = new Hono()

	app.get('/health', (context) => context.json({ status: 'ok' }))
	app.route('/', providerRoutes(loadProviderFixtures(), state))
	app.route('/', mail.app)

	return { app, idle: mail.idle }
}
