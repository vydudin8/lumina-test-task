import { MAILED_WINDOW_DAYS } from '#common/settings.ts'
import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { AppDeps } from '../app.ts'
import { campaigns, cards, contacts, suppressions } from '../db/schema.ts'
import { addOptOut, launchSend, receiveMailWebhook, retrySend } from '../pipeline/send/store.ts'
import { invalidRequest, readBody } from './read-body.ts'
import { requireRole, requireUser, type AppEnv } from './session.ts'

const idParam = z.coerce.number().int().positive()
const optOutBody = z.object({ email: z.string().trim().min(3).max(320), source: z.string().max(200).default('') })

export function sendRoutes(deps: AppDeps) {
	const actorOf = (user: AppEnv['Variables']['user']) => ({ id: user!.id, role: user!.role })

	return new Hono<AppEnv>()
		.post('/campaigns/:id/send', requireRole('lead'), async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			return context.json(
				await launchSend(deps, {
					campaignId: id.data,
					actor: actorOf(context.var.user),
					requestId: context.var.requestId,
				}),
			)
		})
		.post('/cards/:id/retry', requireRole('lead'), async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			return context.json(
				await retrySend(deps, { cardId: id.data, actor: actorOf(context.var.user), requestId: context.var.requestId }),
			)
		})
		.get('/suppressions', requireUser, async (context) => {
			const now = deps.clock()
			const optOuts = await deps.db.select().from(suppressions).orderBy(desc(suppressions.at))
			const known = optOuts.length
				? await deps.db
						.select({ hash: contacts.personKeyHash, fullName: contacts.fullName, title: contacts.title })
						.from(contacts)
						.where(
							inArray(
								contacts.personKeyHash,
								optOuts.map((row) => row.personKeyHash),
							),
						)
				: []
			const since = new Date(now.getTime() - MAILED_WINDOW_DAYS * 86_400_000)
			const recent = await deps.db
				.select({
					cardId: cards.id,
					personKey: cards.personKey,
					recipient: cards.recipient,
					submittedAt: cards.submittedAt,
					status: cards.status,
					campaignId: campaigns.id,
					campaignName: campaigns.name,
				})
				.from(cards)
				.innerJoin(campaigns, eq(cards.campaignId, campaigns.id))
				.where(and(isNotNull(cards.submittedAt), gte(cards.submittedAt, since)))
				.orderBy(desc(cards.submittedAt))
			return context.json({
				optOuts: optOuts.map((row) => {
					const person = known.find((contact) => contact.hash === row.personKeyHash)
					// Only the hash is stored; a name shows only while some provider still lists the person.
					return { ...row, person: person ? { fullName: person.fullName, title: person.title } : null }
				}),
				recentlyMailed: recent.map((row) => ({
					...row,
					// Mailed cards always have a recipient (cards_recipient_present).
					fullName: row.recipient!.fullName,
					recipient: undefined,
					until: new Date(row.submittedAt!.getTime() + MAILED_WINDOW_DAYS * 86_400_000).toISOString(),
				})),
				windowDays: MAILED_WINDOW_DAYS,
			})
		})
		.post('/suppressions', requireUser, async (context) => {
			const body = await readBody(context, optOutBody)
			if (!body) return invalidRequest(context)
			return context.json(
				await addOptOut(deps, {
					email: body.email,
					source: body.source,
					actor: actorOf(context.var.user),
					requestId: context.var.requestId,
				}),
			)
		})
}

// Not under /api: called by the print-and-mail provider, authenticated by its HMAC signature, not by a session.
export function webhookRoutes(deps: AppDeps) {
	// A webhook is a few hundred bytes; refuse anything big before reading it, signed or not.
	const limit = bodyLimit({
		maxSize: 64 * 1024,
		onError: (context) => context.json({ error: 'Payload too large' }, 413),
	})
	return new Hono<AppEnv>().post('/webhooks/mail', limit, async (context) => {
		const result = await receiveMailWebhook(
			{ db: deps.db, log: context.var.log, clock: deps.clock, webhookSecret: deps.webhookSecret },
			{ rawBody: await context.req.text(), signature: context.req.header('x-signature') },
		)
		return context.json(result.body, result.status)
	})
}
