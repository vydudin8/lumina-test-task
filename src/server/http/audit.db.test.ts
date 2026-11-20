import { beforeAll, describe, expect, it } from 'vitest'
import { audit, systemActor } from '../audit.ts'
import { seed } from '../seed/seed.ts'
import { call, createTestApp, loginAs, type FetchApp } from '../test/app.ts'
import { useTestDb } from '../test/db.ts'

describe('audit API', () => {
	const t = useTestDb()
	let app: FetchApp
	let cookie: string

	beforeAll(async () => {
		await seed(t.db, { now: new Date('2026-11-20T12:00:00Z') })
		await audit(t.db, {
			actor: { id: 'usr_rep_tom', role: 'rep' },
			action: 'card.rejected',
			entityType: 'card',
			entityId: 1,
			decision: 'rejected',
			reason: 'Wrong person',
		})
		await audit(t.db, {
			actor: systemActor('send-worker'),
			action: 'card.blocked_at_send',
			entityType: 'card',
			entityId: 2,
			decision: 'blocked',
			reason: 'suppressed:opt_out',
		})
		app = createTestApp(t.db)
		cookie = await loginAs(app, 'usr_lead_maya')
	})

	const list = async (query = '') =>
		(await (await call(app, `/api/audit${query}`, { cookie })).json()) as {
			total: number
			events: { action: string; actorId: string; link: string | null }[]
			filters: { actors: string[]; actions: string[]; entityTypes: string[] }
		}

	it('lists every event, newest first, with the filter options', async () => {
		const result = await list()
		expect(result.total).toBe(9)
		expect(result.events[0]).toMatchObject({ action: 'card.blocked_at_send', actorId: 'system:send-worker' })
		expect(result.filters.actions).toEqual(expect.arrayContaining(['card.rejected', 'suppression.added']))
	})

	it('filters by actor, action and entity', async () => {
		expect((await list('?actor=usr_rep_tom')).events.map((event) => event.action)).toEqual(['card.rejected'])
		expect((await list('?action=suppression.added')).total).toBe(7)
		expect((await list('?entityType=card&entityId=2')).events).toHaveLength(1)
	})

	it('requires a picked user', async () => {
		expect((await call(app, '/api/audit')).status).toBe(401)
	})
})
