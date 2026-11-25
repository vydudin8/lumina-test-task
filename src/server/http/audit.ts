import { and, count, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.ts'
import type { Executor } from '../db/client.ts'
import { auditEvents, cards } from '../db/schema.ts'
import { afterKey, cursorParam, decodeCursor, timestampKey, toPage } from './keyset.ts'
import { invalidRequest, readQuery } from './read-body.ts'
import { requireUser, type AppEnv } from './session.ts'

const query = z.object({
	actor: z.string().max(100).optional(),
	action: z.string().max(100).optional(),
	entityType: z.string().max(50).optional(),
	entityId: z.string().max(50).optional(),
	// Instants, not dates: the browser turns the picked days into its own midnights. `from` inclusive, `to` exclusive.
	from: z.iso.datetime({ offset: true }).optional(),
	to: z.iso.datetime({ offset: true }).optional(),
	cursor: cursorParam,
})
const eventsKey = z.tuple([timestampKey, z.number().int()])
const PAGE_SIZE = 20

// Each of these columns leads an index, so every distinct value is one seek instead of a scan of all events:
// Postgres has no skip scan, so the recursive query jumps to the next value itself.
async function distinctValues(executor: Executor, column: 'actor_id' | 'action' | 'entity_type') {
	const name = sql.identifier(column)
	const { rows } = await executor.execute<{ value: string }>(sql`
		WITH RECURSIVE seen AS (
			(SELECT ${name} AS value FROM audit_events ORDER BY ${name} LIMIT 1)
			UNION ALL
			SELECT (SELECT ${name} FROM audit_events WHERE ${name} > seen.value ORDER BY ${name} LIMIT 1)
			FROM seen WHERE seen.value IS NOT NULL
		)
		SELECT value FROM seen WHERE value IS NOT NULL ORDER BY value`)
	return rows.map((row) => row.value)
}

export function auditRoutes(deps: AppDeps) {
	return new Hono<AppEnv>().get('/audit', requireUser, async (context) => {
		const filters = readQuery(context, query)
		if (!filters) return invalidRequest(context)
		const conditions: (SQL | undefined)[] = [
			filters.actor ? eq(auditEvents.actorId, filters.actor) : undefined,
			filters.action ? eq(auditEvents.action, filters.action) : undefined,
			filters.entityType ? eq(auditEvents.entityType, filters.entityType) : undefined,
			filters.entityId ? eq(auditEvents.entityId, filters.entityId) : undefined,
			filters.from ? gte(auditEvents.at, new Date(filters.from)) : undefined,
			filters.to ? lt(auditEvents.at, new Date(filters.to)) : undefined,
		]
		const where = and(...conditions)
		const key = filters.cursor ? decodeCursor(eventsKey, filters.cursor) : null
		if (filters.cursor && !key) return invalidRequest(context)
		// shortcut: an exact count scans the filtered rows, and an unfiltered one all of them; over many millions of rows, switch the unfiltered total to pg_class.reltuples.
		const [{ total }] = (await deps.db.select({ total: count() }).from(auditEvents).where(where)) as [{ total: number }]
		const rows = await deps.db
			.select({ event: auditEvents, sortKey: sql<string>`${auditEvents.at}::text` })
			.from(auditEvents)
			.where(and(where, key ? afterKey([auditEvents.at, auditEvents.id], key, 'desc') : undefined))
			.orderBy(desc(auditEvents.at), desc(auditEvents.id))
			.limit(PAGE_SIZE + 1)
		const page = toPage(rows, PAGE_SIZE, (row) => [row.sortKey, row.event.id])
		const events = page.items.map((row) => row.event)

		// Where each event's target lives in the app, so the audit log links back to it.
		const cardIds = events.filter((event) => event.entityType === 'card').map((event) => Number(event.entityId))
		const campaignOfCard = new Map(
			cardIds.length
				? (
						await deps.db
							.select({ id: cards.id, campaignId: cards.campaignId })
							.from(cards)
							.where(inArray(cards.id, cardIds))
					).map((row) => [row.id, row.campaignId])
				: [],
		)
		const linkOf = (event: (typeof events)[number]) => {
			if (event.entityType === 'company') return `/companies/${event.entityId}`
			if (event.entityType === 'campaign') return `/campaigns/${event.entityId}`
			if (event.entityType === 'icp_version') return `/scores?version=${event.entityId}`
			if (event.entityType === 'suppression') return '/suppressions'
			if (event.entityType === 'card' && campaignOfCard.has(Number(event.entityId)))
				return `/campaigns/${campaignOfCard.get(Number(event.entityId))}`
			return null
		}

		return context.json({
			total,
			pageSize: PAGE_SIZE,
			nextCursor: page.nextCursor,
			events: events.map((event) => ({ ...event, link: linkOf(event) })),
			filters: {
				actors: await distinctValues(deps.db, 'actor_id'),
				actions: await distinctValues(deps.db, 'action'),
				entityTypes: await distinctValues(deps.db, 'entity_type'),
			},
		})
	})
}
