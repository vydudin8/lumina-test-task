import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { seedUsers } from '../seed/users.ts'
import { call, cookieFrom, createTestApp, loginAs, type FetchApp } from '../test/app.ts'
import { useTestDb } from '../test/db.ts'
import { requireRole, type AppEnv } from './session.ts'

describe('users and session', () => {
	const t = useTestDb()
	let app: FetchApp

	beforeAll(async () => {
		await seedUsers(t.db)
		app = createTestApp(t.db)
	})

	it('lists the seeded users for the picker, leads first', async () => {
		const response = await call(app, '/api/users')
		const { users } = (await response.json()) as { users: { role: string }[] }
		expect(users.length).toBeGreaterThanOrEqual(3)
		expect(users[0]).toMatchObject({ role: 'lead' })
		expect(users.some((user) => user.role === 'rep')).toBe(true)
	})

	it('has no user until one is picked', async () => {
		const response = await call(app, '/api/session')
		await expect(response.json()).resolves.toEqual({ user: null })
	})

	it('picking a user sets a signed HttpOnly cookie that loads the user and role', async () => {
		const response = await call(app, '/api/session', { method: 'PUT', body: { userId: 'usr_lead_maya' } })
		expect(response.status).toBe(200)
		const setCookie = response.headers.get('set-cookie') ?? ''
		expect(setCookie).toMatch(/HttpOnly/)
		expect(setCookie).toMatch(/SameSite=Lax/)

		const session = await call(app, '/api/session', { cookie: cookieFrom(response) })
		await expect(session.json()).resolves.toMatchObject({ user: { id: 'usr_lead_maya', role: 'lead' } })
	})

	it('ignores a tampered cookie', async () => {
		const cookie = await loginAs(app, 'usr_rep_tom')
		const forged = cookie.replace('usr_rep_tom', 'usr_lead_maya')
		const session = await call(app, '/api/session', { cookie: forged })
		await expect(session.json()).resolves.toEqual({ user: null })
	})

	it('rejects an unknown user id', async () => {
		const response = await call(app, '/api/session', { method: 'PUT', body: { userId: 'usr_nobody' } })
		expect(response.status).toBe(400)
	})

	it('clears the session', async () => {
		const response = await call(app, '/api/session', { method: 'DELETE', cookie: await loginAs(app, 'usr_rep_tom') })
		expect(response.status).toBe(204)
		expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/)
	})

	it('rejects a cross-site request', async () => {
		const response = await call(app, '/api/session', {
			method: 'PUT',
			body: { userId: 'usr_lead_maya' },
			headers: { Origin: 'https://evil.example' },
		})
		expect(response.status).toBe(403)
	})

	it('tags every response with a request id', async () => {
		const response = await call(app, '/api/health')
		expect(response.headers.get('x-request-id')).toBeTruthy()
	})
})

describe('requireRole', () => {
	const t = useTestDb()
	let app: FetchApp

	beforeAll(async () => {
		await seedUsers(t.db)
		const routes = new Hono<AppEnv>().post('/lead-only', requireRole('lead'), (context) => context.json({ ok: true }))
		app = createTestApp(t.db).route('/api/test', routes)
	})

	it('returns 401 without a user', async () => {
		expect((await call(app, '/api/test/lead-only', { method: 'POST' })).status).toBe(401)
	})

	it('returns 403 with a plain-language message for a rep', async () => {
		const response = await call(app, '/api/test/lead-only', {
			method: 'POST',
			cookie: await loginAs(app, 'usr_rep_tom'),
		})
		expect(response.status).toBe(403)
		const { error } = (await response.json()) as { error: string }
		expect(error).toMatch(/only a sales lead/i)
	})

	it('lets a lead through', async () => {
		const response = await call(app, '/api/test/lead-only', {
			method: 'POST',
			cookie: await loginAs(app, 'usr_lead_maya'),
		})
		expect(response.status).toBe(200)
	})
})
