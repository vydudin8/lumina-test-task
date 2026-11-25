import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { requestId } from 'hono/request-id'
import { auditRoutes } from './http/audit.ts'
import { campaignRoutes } from './http/campaigns.ts'
import { companyRoutes } from './http/companies.ts'
import { providerRoutes } from './http/providers.ts'
import { sameOriginOnly } from './http/same-origin.ts'
import { scoreRoutes } from './http/scores.ts'
import { sendRoutes, webhookRoutes } from './http/send.ts'
import { loadUser, sessionRoutes, type AppEnv } from './http/session.ts'
import { streamRoutes } from './http/stream.ts'
import { DomainError } from './lib/errors.ts'
import type { Llm } from './llm/types.ts'
import type { IngestDeps } from './pipeline/ingest/index.ts'
import type { MailClient } from './pipeline/send/mail-client.ts'
import type { Hub } from './realtime.ts'

export interface AppDeps extends IngestDeps {
	sessionSecret: string
	llm: Llm
	mail: MailClient
	webhookSecret: string
	hub: Hub
}

export function createApp(deps: AppDeps) {
	const { db, log, sessionSecret } = deps
	const app = new Hono<AppEnv>()

	app.use(requestId())
	app.use(async (context, next) => {
		const started = performance.now()
		context.set('db', db)
		context.set('log', log.child({ requestId: context.var.requestId }))
		await next()
		context.var.log.info(
			{
				method: context.req.method,
				path: context.req.path,
				status: context.res.status,
				ms: Math.round(performance.now() - started),
			},
			'request',
		)
	})
	app.onError((error, context) => {
		if (error instanceof HTTPException) return error.getResponse()
		if (error instanceof DomainError) return context.json({ error: error.message }, error.status)
		context.var.log.error({ err: error }, 'unhandled error')
		return context.json({ error: 'Something went wrong on our side. The error has been logged.' }, 500)
	})

	app.use('/api/*', sameOriginOnly, loadUser(sessionSecret))
	app.get('/api/health', (context) => context.json({ status: 'ok' }))
	app.route('/api', sessionRoutes(sessionSecret))
	app.route('/api', providerRoutes(deps))
	app.route('/api', companyRoutes(deps))
	app.route('/api', scoreRoutes(deps))
	app.route('/api', campaignRoutes(deps))
	app.route('/api', sendRoutes(deps))
	app.route('/api', auditRoutes(deps))
	app.route('/api', streamRoutes(deps))
	app.route('/', webhookRoutes(deps))

	return app
}
