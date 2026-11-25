import { pickUserSchema, type Role, type User } from '#common/schemas.ts'
import { asc, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { RequestIdVariables } from 'hono/request-id'
import type { Db } from '../db/client.ts'
import { users } from '../db/schema.ts'
import type { Logger } from '../log.ts'
import { invalidRequest, readBody } from './read-body.ts'

export type AppEnv = { Variables: RequestIdVariables & { db: Db; log: Logger; user: User | null } }

const COOKIE = 'lumina_user'

async function findUser(db: Db, id: string): Promise<User | null> {
	const [user] = await db.select().from(users).where(eq(users.id, id))
	return user ?? null
}

// No passwords by design (see README): the picker stores the user id in a signed cookie.
export const loadUser = (secret: string) =>
	createMiddleware<AppEnv>(async (context, next) => {
		const userId = await getSignedCookie(context, secret, COOKIE)
		context.set('user', userId ? await findUser(context.var.db, userId) : null)
		await next()
	})

export const requireUser = createMiddleware<AppEnv>(async (context, next) => {
	if (!context.var.user) return context.json({ error: 'Pick a user in the header first.' }, 401)
	await next()
})

const roleLabels: Record<Role, string> = { rep: 'sales rep', lead: 'sales lead' }

export const requireRole = (role: Role) =>
	createMiddleware<AppEnv>(async (context, next) => {
		const user = context.var.user
		if (!user) return context.json({ error: 'Pick a user in the header first.' }, 401)
		if (user.role !== role) {
			return context.json(
				{ error: `Only a ${roleLabels[role]} can do this. You are signed in as a ${roleLabels[user.role]}.` },
				403,
			)
		}
		await next()
	})

export function sessionRoutes(secret: string) {
	return new Hono<AppEnv>()
		.get('/users', async (context) => {
			const rows = await context.var.db.select().from(users).orderBy(desc(users.role), asc(users.name))
			return context.json({ users: rows })
		})
		.get('/session', (context) => context.json({ user: context.var.user }))
		.put('/session', async (context) => {
			const data = await readBody(context, pickUserSchema)
			const user = data && (await findUser(context.var.db, data.userId))
			if (!user) return invalidRequest(context)

			await setSignedCookie(context, COOKIE, user.id, secret, {
				httpOnly: true,
				sameSite: 'Lax',
				path: '/',
				// Behind a TLS-terminating proxy (Railway, Render) the app sees http:// and the proxy names the browser's
				// scheme. A client forging the header only makes its own cookie stricter.
				secure:
					new URL(context.req.url).protocol === 'https:' ||
					context.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https',
				maxAge: 60 * 60 * 24 * 7,
			})
			return context.json({ user })
		})
		.delete('/session', (context) => {
			deleteCookie(context, COOKIE, { path: '/' })
			return context.body(null, 204)
		})
}
