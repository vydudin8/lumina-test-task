import { beforeAll, describe, expect, it } from 'vitest'
import { audit, systemActor } from '../audit.ts'
import { auditEvents } from '../db/schema.ts'
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
			nextCursor: string | null
			events: { id: number; action: string; actorId: string; link: string | null }[]
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

	it('filters by a time range: from is inclusive, to is exclusive', async () => {
		const hour = 3_600_000
		const at = (offset: number) => encodeURIComponent(new Date(Date.now() + offset).toISOString())
		expect((await list(`?from=${at(-hour)}&to=${at(hour)}`)).total).toBe(9)
		expect((await list(`?from=${at(hour)}`)).total).toBe(0)
		expect((await list(`?to=${at(-hour)}`)).total).toBe(0)
		expect((await list(`?action=suppression.added&to=${at(hour)}`)).total).toBe(7)
		expect((await call(app, '/api/audit?from=yesterday', { cookie })).status).toBe(400)
	})

	it('requires a picked user', async () => {
		expect((await call(app, '/api/audit')).status).toBe(401)
	})

	it('pages with a cursor: events written meanwhile never repeat or hide a row', async () => {
		for (let i = 0; i < 30; i++)
			await audit(t.db, {
				actor: systemActor('test'),
				action: 'card.blocked_at_send',
				entityType: 'card',
				entityId: i,
			})
		const first = await list('?actor=system:test')
		expect(first.total).toBe(30)
		expect(first.events).toHaveLength(20)

		// Newer events land on top of the log; the second page still starts right after the first one.
		await audit(t.db, { actor: systemActor('test'), action: 'card.blocked_at_send', entityType: 'card', entityId: 99 })
		const second = await list(`?actor=system:test&cursor=${first.nextCursor}`)
		expect(second.events).toHaveLength(10)
		expect(second.nextCursor).toBeNull()
		const ids = [...first.events, ...second.events].map((event) => event.id)
		expect(new Set(ids).size).toBe(30)
	})

	it('rejects a forged cursor', async () => {
		expect((await call(app, '/api/audit?cursor=bm90LWpzb24', { cookie })).status).toBe(400)
	})
	it('offers exactly the distinct values of each filter, in order', async () => {
		const distinct = async (column: (typeof auditEvents)['actorId' | 'action' | 'entityType']) =>
			(await t.db.selectDistinct({ value: column }).from(auditEvents).orderBy(column)).map((row) => row.value)
		expect((await list()).filters).toEqual({
			actors: await distinct(auditEvents.actorId),
			actions: await distinct(auditEvents.action),
			entityTypes: await distinct(auditEvents.entityType),
		})
	})
})
