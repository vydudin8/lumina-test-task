import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.ts'
import { auditEvents, campaigns, cards, submissionAttempts, templates } from '../db/schema.ts'
import {
	approveCard,
	approveEligible,
	createCampaign,
	editLine,
	rejectCard,
	type CampaignDeps,
} from '../pipeline/campaign/store.ts'
import { invalidRequest, readBody } from './read-body.ts'
import { requireRole, requireUser, type AppEnv } from './session.ts'

const createBody = z.object({
	name: z.string().trim().min(1).max(120),
	topN: z.number().int().min(1).max(500),
	templateAId: z.number().int().positive(),
	templateBId: z.number().int().positive(),
	icpVersionId: z.number().int().positive().optional(),
})
const idParam = z.coerce.number().int().positive()
const reasonBody = z.object({ reason: z.string().max(500) })
const lineBody = z.object({ text: z.string().max(1000) })

type Card = typeof cards.$inferSelect

function summarise(rows: Card[]) {
	const byStatus: Record<string, number> = {}
	const blocked: Record<string, number> = {}
	for (const card of rows) {
		byStatus[card.status] = (byStatus[card.status] ?? 0) + 1
		if (card.blockReason) blocked[card.blockReason] = (blocked[card.blockReason] ?? 0) + 1
	}
	return {
		total: rows.length,
		eligible: rows.filter((card) => card.eligibility === 'eligible').length,
		byStatus,
		blocked,
		llmRejected: rows.filter((card) => card.llmStatus === 'rejected').length,
		variants: {
			A: rows.filter((card) => card.variant === 'A').length,
			B: rows.filter((card) => card.variant === 'B').length,
		},
	}
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
			return context.json({ templates: await deps.db.select().from(templates).orderBy(asc(templates.variant)) })
		})
		.get('/campaigns', requireUser, async (context) => {
			const rows = await deps.db.select().from(campaigns).orderBy(desc(campaigns.createdAt), desc(campaigns.id))
			const allCards = rows.length
				? await deps.db
						.select()
						.from(cards)
						.where(
							inArray(
								cards.campaignId,
								rows.map((row) => row.id),
							),
						)
				: []
			return context.json({
				campaigns: rows.map((campaign) => ({
					...campaign,
					summary: summarise(allCards.filter((card) => card.campaignId === campaign.id)),
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
			const [campaign] = await deps.db.select().from(campaigns).where(eq(campaigns.id, id.data))
			if (!campaign) return context.json({ error: 'Campaign not found' }, 404)
			const rows = await deps.db.select().from(cards).where(eq(cards.campaignId, campaign.id)).orderBy(asc(cards.rank))
			const campaignTemplates = await deps.db
				.select()
				.from(templates)
				.where(inArray(templates.id, [campaign.templateAId, campaign.templateBId]))
			const activity = await deps.db
				.select()
				.from(auditEvents)
				.where(
					or(
						and(eq(auditEvents.entityType, 'campaign'), eq(auditEvents.entityId, String(campaign.id))),
						rows.length
							? and(
									eq(auditEvents.entityType, 'card'),
									inArray(
										auditEvents.entityId,
										rows.map((card) => String(card.id)),
									),
								)
							: undefined,
					),
				)
				.orderBy(desc(auditEvents.at), desc(auditEvents.id))
				.limit(200)
			const attempts = rows.length
				? await deps.db
						.select()
						.from(submissionAttempts)
						.where(
							inArray(
								submissionAttempts.cardId,
								rows.map((card) => card.id),
							),
						)
						.orderBy(asc(submissionAttempts.n))
				: []
			return context.json({
				campaign,
				cards: rows.map((card) => ({ ...card, attempts: attempts.filter((attempt) => attempt.cardId === card.id) })),
				templates: campaignTemplates,
				summary: summarise(rows),
				activity,
			})
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
}
