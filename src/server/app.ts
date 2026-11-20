import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { requestId } from 'hono/request-id'
import type { Db } from './db/client.ts'
import { sameOriginOnly } from './http/same-origin.ts'
import { loadUser, sessionRoutes, type AppEnv } from './http/session.ts'
import type { Logger } from './log.ts'

export interface AppDeps {
	db: Db
	log: Logger
	sessionSecret: string
}

export function createApp({ db, log, sessionSecret }: AppDeps) {
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
		context.var.log.error({ err: error }, 'unhandled error')
		return context.json({ error: 'Something went wrong on our side. The error has been logged.' }, 500)
	})

	app.use('/api/*', sameOriginOnly, loadUser(sessionSecret))
	app.get('/api/health', (context) => context.json({ status: 'ok' }))
	app.route('/api', sessionRoutes(sessionSecret))

	return app
}
