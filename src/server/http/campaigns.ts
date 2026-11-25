import { and, asc, count, desc, eq, getTableColumns, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.ts'
import type { Executor } from '../db/client.ts'
import { auditEvents, campaigns, cards, companyProfiles, jobs, submissionAttempts, templates } from '../db/schema.ts'
import { JOB_KINDS } from '../jobs.ts'
import { groupActivity } from '../pipeline/campaign/activity.ts'
import {
	approveCard,
	approveCards,
	approveEligible,
	createCampaign,
	editLine,
	rejectCard,
	rejectCards,
	type CampaignDeps,
} from '../pipeline/campaign/store.ts'
import { cardCompany } from '../pipeline/resolve/store.ts'
import { campaignResults, logOutcome } from '../pipeline/results/store.ts'
import { afterKey, cursorParam, decodeCursor, encodeCursor, timestampKey, toPage } from './keyset.ts'
import { invalidRequest, readBody, readQuery } from './read-body.ts'
import { requireRole, requireUser, type AppEnv } from './session.ts'

const createBody = z.object({
	name: z.string().trim().min(1).max(120),
	topN: z.number().int().min(1).max(500),
	templateAId: z.number().int().positive(),
	// Null runs the campaign without an A/B test.
	templateBId: z.number().int().positive().nullable(),
	icpVersionId: z.number().int().positive().optional(),
})
const idParam = z.coerce.number().int().positive()
const reasonBody = z.object({ reason: z.string().max(500) })
const cardIds = z.array(z.number().int().positive()).min(1).max(500)
const approveCardsBody = z.object({ cardIds })
const rejectCardsBody = z.object({ cardIds, reason: z.string().max(500) })
const activityQuery = z.object({
	// Instants, as on the audit log: `from` inclusive, `to` exclusive.
	from: z.iso.datetime({ offset: true }).optional(),
	to: z.iso.datetime({ offset: true }).optional(),
	action: z.string().max(100).optional(),
	card: z.coerce.number().int().positive().optional(),
	// An offset into the grouped list.
	cursor: z
		.string()
		.regex(/^\d{1,9}$/)
		.optional(),
})
const ACTIVITY_PAGE_SIZE = 20
const listQuery = z.object({ cursor: cursorParam })
const listKey = z.tuple([timestampKey, z.number().int()])
const LIST_PAGE_SIZE = 20
// What each view of the cards (the Status filter on the campaign page) holds.
const CARD_VIEWS: Record<string, SQL> = {
	all: sql`true`,
	review: eq(cards.status, 'draft'),
	approved: sql`${cards.approvedAt} IS NOT NULL`,
	sent: sql`${cards.submittedAt} IS NOT NULL`,
	delivered: eq(cards.status, 'delivered'),
	attention: inArray(cards.status, ['failed', 'unconfirmed']),
	blocked: inArray(cards.status, ['blocked', 'blocked_at_send']),
	rejected: eq(cards.status, 'rejected'),
	'ai-rejected': eq(cards.llmStatus, 'rejected'),
}
const cardsQuery = z.object({
	// Part of the company's name, as the search box on the campaign page.
	q: z.string().trim().max(200).optional(),
	show: z.enum(Object.keys(CARD_VIEWS) as [string, ...string[]]).default('all'),
	template: z.enum(['A', 'B']).optional(),
	cursor: cursorParam,
})
const cardsKey = z.tuple([z.number().int(), z.number().int()])
const CARDS_PAGE_SIZE = 50
const lineBody = z.object({ text: z.string().max(1000) })
const outcomeBody = z.object({
	kind: z.enum(['reply', 'meeting']),
	occurredAt: z.iso.datetime({ offset: true }).optional(),
	note: z.string().max(500).optional(),
})

// Only what the client reads: request hashes, idempotency keys and the model's raw output stay in the database.
const { requestHash, idempotencyKey: campaignKey, ...campaignColumns } = getTableColumns(campaigns)
// contributions stay: the score sidebar shows the breakdown as it was when the campaign was built.
const { llmRaw, promptVersion, idempotencyKey: cardKey, ...cardColumns } = getTableColumns(cards)

type Funnel = Pick<
	typeof cards.$inferSelect,
	'status' | 'eligibility' | 'blockReason' | 'llmStatus' | 'variant' | 'approvedAt' | 'submittedAt' | 'personalLine'
>

// The shape of a campaign's funnel, counted in SQL by campaignSummaries below; a campaign without cards has no rows
// to count, so it gets this function's answer for no cards.
function summarise(rows: Funnel[]) {
	const byStatus: Record<string, number> = {}
	const blocked: Record<string, number> = {}
	for (const card of rows) {
		byStatus[card.status] = (byStatus[card.status] ?? 0) + 1
		// Blocked when built; cards stopped by the re-check at send are counted on their own below.
		if (card.blockReason && card.eligibility === 'blocked')
			blocked[card.blockReason] = (blocked[card.blockReason] ?? 0) + 1
	}
	return {
		total: rows.length,
		eligible: rows.filter((card) => card.eligibility === 'eligible').length,
		byStatus,
		blocked,
		llmRejected: rows.filter((card) => card.llmStatus === 'rejected').length,
		blockedAtSend: rows.filter((card) => card.status === 'blocked_at_send').length,
		approved: rows.filter((card) => card.approvedAt !== null).length,
		toReview: rows.filter((card) => card.status === 'draft' && card.eligibility === 'eligible').length,
		linesPending: rows.filter(
			(card) => card.status === 'draft' && card.eligibility === 'eligible' && !card.personalLine,
		).length,
		ready: rows.filter((card) => card.status === 'approved').length,
		sent: rows.filter((card) => card.submittedAt !== null).length,
		delivered: rows.filter((card) => card.status === 'delivered').length,
		returned: rows.filter((card) => card.status === 'returned').length,
		needsAttention: rows.filter((card) => card.status === 'failed' || card.status === 'unconfirmed').length,
		// Set from the jobs table by campaignSummaries; the cards alone cannot tell a stopped job from a slow one.
		linesFailed: false,
		variants: {
			A: rows.filter((card) => card.variant === 'A').length,
			B: rows.filter((card) => card.variant === 'B').length,
		},
	}
}

const countWhere = (condition: SQL) => sql`count(*) filter (where ${condition})`.mapWith(Number)

// summarise() for many campaigns at once, counted in SQL so a list never loads the cards themselves.
async function campaignSummaries(executor: Executor, campaignIds: number[]) {
	const summaries = new Map<number, ReturnType<typeof summarise>>()
	if (campaignIds.length === 0) return summaries
	const inCampaigns = inArray(cards.campaignId, campaignIds)
	const [totals, groups, linesJobs] = await Promise.all([
		executor
			.select({
				campaignId: cards.campaignId,
				total: count(),
				eligible: countWhere(eq(cards.eligibility, 'eligible')),
				llmRejected: countWhere(eq(cards.llmStatus, 'rejected')),
				blockedAtSend: countWhere(eq(cards.status, 'blocked_at_send')),
				approved: countWhere(sql`${cards.approvedAt} IS NOT NULL`),
				toReview: countWhere(and(eq(cards.status, 'draft'), eq(cards.eligibility, 'eligible'))!),
				// Eligible cards the "write lines" job has not reached yet.
				linesPending: countWhere(
					and(eq(cards.status, 'draft'), eq(cards.eligibility, 'eligible'), isNull(cards.personalLine))!,
				),
				ready: countWhere(eq(cards.status, 'approved')),
				sent: countWhere(sql`${cards.submittedAt} IS NOT NULL`),
				delivered: countWhere(eq(cards.status, 'delivered')),
				returned: countWhere(eq(cards.status, 'returned')),
				needsAttention: countWhere(inArray(cards.status, ['failed', 'unconfirmed'])),
				a: countWhere(eq(cards.variant, 'A')),
				b: countWhere(eq(cards.variant, 'B')),
			})
			.from(cards)
			.where(inCampaigns)
			.groupBy(cards.campaignId),
		executor
			.select({
				campaignId: cards.campaignId,
				status: cards.status,
				eligibility: cards.eligibility,
				blockReason: cards.blockReason,
				n: count(),
			})
			.from(cards)
			.where(inCampaigns)
			.groupBy(cards.campaignId, cards.status, cards.eligibility, cards.blockReason),
		// Each campaign's latest "write lines" job.
		executor
			.selectDistinctOn([jobs.key], { key: jobs.key, status: jobs.status })
			.from(jobs)
			.where(and(eq(jobs.kind, JOB_KINDS.lines), inArray(jobs.key, campaignIds.map(String))))
			.orderBy(jobs.key, desc(jobs.id)),
	])
	const failed = new Set(linesJobs.filter((job) => job.status === 'failed').map((job) => Number(job.key)))
	for (const { campaignId, a, b, ...row } of totals)
		summaries.set(campaignId, {
			...row,
			linesFailed: failed.has(campaignId),
			byStatus: {},
			blocked: {},
			variants: { A: a, B: b },
		})
	for (const { campaignId, status, eligibility, blockReason, n } of groups) {
		const summary = summaries.get(campaignId)!
		summary.byStatus[status] = (summary.byStatus[status] ?? 0) + n
		if (blockReason && eligibility === 'blocked') summary.blocked[blockReason] = (summary.blocked[blockReason] ?? 0) + n
	}
	return summaries
}

export function campaignRoutes(deps: AppDeps) {
	const campaignDeps = (log: AppDeps['log']): CampaignDeps => ({
		db: deps.db,
		llm: deps.llm,
		log,
		retry: deps.retry,
		clock: deps.clock,
	})
	const actorOf = (user: AppEnv['Variables']['user']) => ({ id: user!.id, role: user!.role })

	return new Hono<AppEnv>()
		.get('/templates', requireUser, async (context) => {
			return context.json({ templates: await deps.db.select().from(templates).orderBy(asc(templates.id)) })
		})
		.get('/campaigns', requireUser, async (context) => {
			const query = readQuery(context, listQuery)
			if (!query) return invalidRequest(context)
			const key = query.cursor ? decodeCursor(listKey, query.cursor) : null
			if (query.cursor && !key) return invalidRequest(context)
			const [{ total }] = (await deps.db.select({ total: count() }).from(campaigns)) as [{ total: number }]
			const rows = await deps.db
				.select({ campaign: campaignColumns, sortKey: sql<string>`${campaigns.createdAt}::text` })
				.from(campaigns)
				.where(key ? afterKey([campaigns.createdAt, campaigns.id], key, 'desc') : undefined)
				.orderBy(desc(campaigns.createdAt), desc(campaigns.id))
				.limit(LIST_PAGE_SIZE + 1)
			const page = toPage(rows, LIST_PAGE_SIZE, (row) => [row.sortKey, row.campaign.id])
			const summaries = await campaignSummaries(
				deps.db,
				page.items.map((row) => row.campaign.id),
			)
			return context.json({
				total,
				pageSize: LIST_PAGE_SIZE,
				nextCursor: page.nextCursor,
				campaigns: page.items.map(({ campaign }) => ({
					...campaign,
					// A campaign without cards has no row in the counts.
					summary: summaries.get(campaign.id) ?? summarise([]),
				})),
			})
		})
		.post('/campaigns', requireUser, async (context) => {
			const idempotencyKey = context.req.header('idempotency-key')?.trim()
			if (!idempotencyKey || idempotencyKey.length > 200)
				return context.json(
					{ error: 'Send an Idempotency-Key header, so a retry cannot create a second campaign.' },
					400,
				)
			const body = await readBody(context, createBody)
			if (!body) return invalidRequest(context)
			const result = await createCampaign(campaignDeps(context.var.log), {
				...body,
				idempotencyKey,
				actor: actorOf(context.var.user),
				requestId: context.var.requestId,
			})
			return context.json(result, result.created ? 201 : 200)
		})
		.get('/campaigns/:id', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			const [campaign] = await deps.db.select(campaignColumns).from(campaigns).where(eq(campaigns.id, id.data))
			if (!campaign) return context.json({ error: 'Campaign not found' }, 404)
			// The cards come page by page from /cards; this stays small however many tabs refetch it on a notice.
			const [campaignTemplates, summaries, [linesJob]] = await Promise.all([
				deps.db
					.select()
					.from(templates)
					.where(inArray(templates.id, [campaign.templateAId, campaign.templateBId ?? campaign.templateAId])),
				campaignSummaries(deps.db, [campaign.id]),
				// Latest job for this campaign: the page says so when writing the lines failed.
				deps.db
					.select({ status: jobs.status, error: jobs.error })
					.from(jobs)
					.where(and(eq(jobs.kind, JOB_KINDS.lines), eq(jobs.key, String(campaign.id))))
					.orderBy(desc(jobs.id))
					.limit(1),
			])
			return context.json({
				campaign,
				linesJob: linesJob ?? null,
				templates: campaignTemplates,
				summary: summaries.get(campaign.id) ?? summarise([]),
			})
		})
		.get('/campaigns/:id/cards', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			const filters = readQuery(context, cardsQuery)
			if (!id.success || !filters) return invalidRequest(context)
			const key = filters.cursor ? decodeCursor(cardsKey, filters.cursor) : null
			if (filters.cursor && !key) return invalidRequest(context)
			const [campaign] = await deps.db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, id.data))
			if (!campaign) return context.json({ error: 'Campaign not found' }, 404)
			// Matches the label the card shows: the company name, or its number when it has none.
			const company = filters.q
				? sql`strpos(lower(coalesce((SELECT ${companyProfiles.name} FROM ${companyProfiles} WHERE ${companyProfiles.companyId} = ${cardCompany}), 'Company #' || ${cardCompany})), lower(${filters.q})) > 0`
				: undefined
			const inCampaign = and(eq(cards.campaignId, campaign.id), company)
			const variant = filters.template ? eq(cards.variant, filters.template) : undefined
			// Each filter counts the cards the other filters leave, so an option's count is what picking it shows.
			const [[views], [variants]] = await Promise.all([
				deps.db
					.select(
						Object.fromEntries(Object.entries(CARD_VIEWS).map(([view, condition]) => [view, countWhere(condition)])),
					)
					.from(cards)
					.where(and(inCampaign, variant)),
				deps.db
					.select({ A: countWhere(eq(cards.variant, 'A')), B: countWhere(eq(cards.variant, 'B')) })
					.from(cards)
					.where(and(inCampaign, CARD_VIEWS[filters.show])),
			])
			const rows = await deps.db
				// The company the card belongs to now, so a merge or split since never leaves it pointing nowhere.
				.select({ ...cardColumns, companyId: cardCompany, companyName: companyProfiles.name })
				.from(cards)
				.leftJoin(companyProfiles, eq(companyProfiles.companyId, cardCompany))
				.where(
					and(
						inCampaign,
						variant,
						CARD_VIEWS[filters.show],
						key ? afterKey([cards.rank, cards.id], key, 'asc') : undefined,
					),
				)
				.orderBy(asc(cards.rank), asc(cards.id))
				.limit(CARDS_PAGE_SIZE + 1)
			const page = toPage(rows, CARDS_PAGE_SIZE, (card) => [card.rank, card.id])
			const attempts = new Map<number, (typeof submissionAttempts.$inferSelect)[]>()
			if (page.items.length)
				for (const attempt of await deps.db
					.select()
					.from(submissionAttempts)
					.where(
						inArray(
							submissionAttempts.cardId,
							page.items.map((card) => card.id),
						),
					)
					.orderBy(asc(submissionAttempts.n)))
					attempts.set(attempt.cardId, [...(attempts.get(attempt.cardId) ?? []), attempt])
			return context.json({
				total: views![filters.show]!,
				pageSize: CARDS_PAGE_SIZE,
				nextCursor: page.nextCursor,
				counts: { views, variants },
				cards: page.items.map((card) => ({
					...card,
					attempts: attempts.get(card.id) ?? [],
				})),
			})
		})
		.get('/campaigns/:id/cards/:cardId/cursors', requireUser, async (context) => {
			// The cursors that lead to the page holding a card, so a link to one card (from the results) can open it.
			const id = idParam.safeParse(context.req.param('id'))
			const cardId = idParam.safeParse(context.req.param('cardId'))
			if (!id.success || !cardId.success) return invalidRequest(context)
			// shortcut: reads the rank and id of every card of the campaign (at most 500); use a window query if campaigns grow.
			const order = await deps.db
				.select({ id: cards.id, rank: cards.rank })
				.from(cards)
				.where(eq(cards.campaignId, id.data))
				.orderBy(asc(cards.rank), asc(cards.id))
			const index = order.findIndex((card) => card.id === cardId.data)
			if (index < 0) return context.json({ error: 'Card not found' }, 404)
			const cursors = Array.from({ length: Math.floor(index / CARDS_PAGE_SIZE) }, (_, page) => {
				const last = order[(page + 1) * CARDS_PAGE_SIZE - 1]!
				return encodeCursor([last.rank, last.id])
			})
			return context.json({ cursors })
		})
		.post('/campaigns/:id/approve-eligible', requireRole('lead'), async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			return context.json(
				await approveEligible(campaignDeps(context.var.log), {
					campaignId: id.data,
					actor: actorOf(context.var.user),
					requestId: context.var.requestId,
				}),
			)
		})
		.post('/campaigns/:id/approve', requireRole('lead'), async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			const body = await readBody(context, approveCardsBody)
			if (!id.success || !body) return invalidRequest(context)
			return context.json(
				await approveCards(campaignDeps(context.var.log), {
					campaignId: id.data,
					cardIds: body.cardIds,
					actor: actorOf(context.var.user),
					requestId: context.var.requestId,
				}),
			)
		})
		.post('/campaigns/:id/reject', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			const body = await readBody(context, rejectCardsBody)
			if (!id.success || !body) return invalidRequest(context)
			return context.json(
				await rejectCards(campaignDeps(context.var.log), {
					campaignId: id.data,
					cardIds: body.cardIds,
					reason: body.reason,
					actor: actorOf(context.var.user),
					requestId: context.var.requestId,
				}),
			)
		})
		.get('/campaigns/:id/activity', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			const filters = readQuery(context, activityQuery)
			if (!id.success || !filters) return invalidRequest(context)
			const [campaign] = await deps.db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, id.data))
			if (!campaign) return context.json({ error: 'Campaign not found' }, 404)
			// The history sheet names the cards its entries are about, and filters by them.
			const roster = await deps.db
				.select({
					id: cards.id,
					rank: cards.rank,
					companyId: cardCompany,
					status: cards.status,
					fullName: sql<string | null>`${cards.recipient}->>'fullName'`,
					companyName: companyProfiles.name,
				})
				.from(cards)
				.leftJoin(companyProfiles, eq(companyProfiles.companyId, cardCompany))
				.where(eq(cards.campaignId, campaign.id))
				.orderBy(asc(cards.rank))
			const cardIds = roster.map((card) => String(card.id))
			const scope = or(
				and(eq(auditEvents.entityType, 'campaign'), eq(auditEvents.entityId, String(campaign.id))),
				cardIds.length ? and(eq(auditEvents.entityType, 'card'), inArray(auditEvents.entityId, cardIds)) : undefined,
			)
			const conditions: (SQL | undefined)[] = [
				scope,
				filters.action ? eq(auditEvents.action, filters.action) : undefined,
				filters.card
					? and(eq(auditEvents.entityType, 'card'), eq(auditEvents.entityId, String(filters.card)))
					: undefined,
				filters.from ? gte(auditEvents.at, new Date(filters.from)) : undefined,
				filters.to ? lt(auditEvents.at, new Date(filters.to)) : undefined,
			]
			// shortcut: grouping and paging run in memory because a campaign has at most 500 cards with a few events each; move to SQL if that grows.
			const events = await deps.db
				.select()
				.from(auditEvents)
				.where(and(...conditions))
				.orderBy(desc(auditEvents.at), desc(auditEvents.id))
			const groups = groupActivity(events)
			const offset = Number(filters.cursor ?? 0)
			const next = offset + ACTIVITY_PAGE_SIZE
			const link = `/campaigns/${campaign.id}`
			const actions = await deps.db
				.selectDistinct({ action: auditEvents.action })
				.from(auditEvents)
				.where(scope)
				.orderBy(asc(auditEvents.action))
			return context.json({
				total: groups.length,
				pageSize: ACTIVITY_PAGE_SIZE,
				nextCursor: next < groups.length ? String(next) : null,
				groups: groups.slice(offset, next).map((group) => ({
					...group,
					events: group.events.map((event) => ({ ...event, link })),
				})),
				actions: actions.map((row) => row.action),
				cards: roster,
			})
		})
		.post('/cards/:id/approve', requireRole('lead'), async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			return context.json(
				await approveCard(campaignDeps(context.var.log), {
					cardId: id.data,
					actor: actorOf(context.var.user),
					requestId: context.var.requestId,
				}),
			)
		})
		.post('/cards/:id/reject', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			const body = await readBody(context, reasonBody)
			if (!id.success || !body) return invalidRequest(context)
			return context.json(
				await rejectCard(campaignDeps(context.var.log), {
					cardId: id.data,
					reason: body.reason,
					actor: actorOf(context.var.user),
					requestId: context.var.requestId,
				}),
			)
		})
		.post('/cards/:id/line', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			const body = await readBody(context, lineBody)
			if (!id.success || !body) return invalidRequest(context)
			return context.json(
				await editLine(campaignDeps(context.var.log), {
					cardId: id.data,
					text: body.text,
					actor: actorOf(context.var.user),
					requestId: context.var.requestId,
				}),
			)
		})
		.get('/campaigns/:id/results', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			return context.json(await campaignResults(deps.db, id.data))
		})
		.post('/cards/:id/outcomes', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			const body = await readBody(context, outcomeBody)
			const idempotencyKey = context.req.header('idempotency-key')?.trim()
			if (!id.success || !body) return invalidRequest(context)
			if (!idempotencyKey)
				return context.json({ error: 'Send an Idempotency-Key header, so a retry cannot log the outcome twice.' }, 400)
			const result = await logOutcome(deps, {
				cardId: id.data,
				kind: body.kind,
				occurredAt: body.occurredAt ? new Date(body.occurredAt) : deps.clock(),
				note: body.note,
				idempotencyKey,
				actor: actorOf(context.var.user),
				requestId: context.var.requestId,
			})
			return context.json(result, result.created ? 201 : 200)
		})
}
