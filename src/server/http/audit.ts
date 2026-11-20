import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.ts'
import { auditEvents, cards } from '../db/schema.ts'
import { invalidRequest, readQuery } from './read-body.ts'
import { requireUser, type AppEnv } from './session.ts'

const query = z.object({
	actor: z.string().max(100).optional(),
	action: z.string().max(100).optional(),
	entityType: z.string().max(50).optional(),
	entityId: z.string().max(50).optional(),
	offset: z.coerce.number().int().min(0).default(0),
})
const PAGE_SIZE = 50

export function auditRoutes(deps: AppDeps) {
	return new Hono<AppEnv>().get('/audit', requireUser, async (context) => {
		const filters = readQuery(context, query)
		if (!filters) return invalidRequest(context)
		const conditions: (SQL | undefined)[] = [
			filters.actor ? eq(auditEvents.actorId, filters.actor) : undefined,
			filters.action ? eq(auditEvents.action, filters.action) : undefined,
			filters.entityType ? eq(auditEvents.entityType, filters.entityType) : undefined,
			filters.entityId ? eq(auditEvents.entityId, filters.entityId) : undefined,
		]
		const where = and(...conditions)
		const [{ total }] = (await deps.db.select({ total: count() }).from(auditEvents).where(where)) as [{ total: number }]
		const events = await deps.db
			.select()
			.from(auditEvents)
			.where(where)
			.orderBy(desc(auditEvents.at), desc(auditEvents.id))
			.limit(PAGE_SIZE)
			.offset(filters.offset)

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

		const distinct = async (
			column: typeof auditEvents.actorId | typeof auditEvents.action | typeof auditEvents.entityType,
		) => (await deps.db.selectDistinct({ value: column }).from(auditEvents).orderBy(column)).map((row) => row.value)

		return context.json({
			total,
			offset: filters.offset,
			pageSize: PAGE_SIZE,
			events: events.map((event) => ({ ...event, link: linkOf(event) })),
			filters: {
				actors: await distinct(auditEvents.actorId),
				actions: await distinct(auditEvents.action),
				entityTypes: await distinct(auditEvents.entityType),
			},
		})
	})
}
