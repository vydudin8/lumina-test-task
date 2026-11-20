import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { audit, systemActor } from '../../audit.ts'
import type { Db, Executor } from '../../db/client.ts'
import { campaigns, cards, mailEvents, submissionAttempts, suppressions, templates } from '../../db/schema.ts'
import type { Clock } from '../../lib/clock.ts'
import { DomainError } from '../../lib/errors.ts'
import { HttpError, retry, type RetryOptions } from '../../lib/retry.ts'
import type { Logger } from '../../log.ts'
import { personKey, personKeyHash } from '../../policy/person-key.ts'
import { blockReason } from '../campaign/core.ts'
import { loadSuppressionState } from '../campaign/store.ts'
import type { Address } from '../resolve/core.ts'
import { postcardBody, submitPostcard, type MailClient } from './mail-client.ts'

type UserActor = { id: string; role: 'rep' | 'lead' }

export interface SendDeps {
	db: Db
	log: Logger
	clock: Clock
	mail: MailClient
	retry: RetryOptions
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))
const worker = systemActor('send-worker')

// Lead only (also enforced by the campaigns_launcher_is_lead CHECK). Queues every approved card; a repeat with nothing
// newly approved changes nothing and writes no audit event.
export async function launchSend(
	deps: Pick<SendDeps, 'db' | 'clock'>,
	input: { campaignId: number; actor: UserActor; requestId?: string },
) {
	if (input.actor.role !== 'lead') throw new DomainError('Only a sales lead can launch a send.', 403)
	const now = deps.clock()
	return deps.db.transaction(async (tx) => {
		const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, input.campaignId)).for('update')
		if (!campaign) throw new DomainError('Campaign not found.', 404)
		const queued = await tx
			.update(cards)
			.set({ status: 'queued', statusChangedAt: now })
			.where(and(eq(cards.campaignId, campaign.id), eq(cards.status, 'approved')))
			.returning({ id: cards.id })
		if (queued.length === 0) return { queued: 0, campaign }

		const [updated] = await tx
			.update(campaigns)
			.set({
				status: 'sending',
				launchedBy: campaign.launchedBy ?? input.actor.id,
				launchedByRole: campaign.launchedByRole ?? 'lead',
				launchedAt: campaign.launchedAt ?? now,
			})
			.where(eq(campaigns.id, campaign.id))
			.returning()
		await audit(tx, {
			actor: input.actor,
			action: 'campaign.send_launched',
			entityType: 'campaign',
			entityId: campaign.id,
			before: { status: campaign.status },
			after: { status: 'sending' },
			result: { cards_queued: queued.length },
			requestId: input.requestId,
		})
		return { queued: queued.length, campaign: updated! }
	})
}

type Attempt = typeof submissionAttempts.$inferInsert

function attemptRow(cardId: number, n: number, error: unknown, delayMs: number | null, at: Date): Attempt {
	const timeout = error instanceof Error && error.name === 'TimeoutError'
	return {
		cardId,
		n,
		outcome: timeout ? 'timeout' : 'error',
		httpStatus: error instanceof HttpError ? error.status : null,
		delayMs,
		error: describe(error).slice(0, 500),
		at,
	}
}

// Takes one queued card under FOR UPDATE SKIP LOCKED, re-checks it, submits it and records the outcome, all in one
// transaction. shortcut: the row stays locked during the HTTP call and its retries; fine for one worker at demo
// volume, move to a claim column plus a lease before running several workers.
export async function processOne(deps: SendDeps): Promise<'submitted' | 'blocked' | 'failed' | null> {
	const now = deps.clock()
	return deps.db.transaction(async (tx) => {
		const [card] = await tx
			.select()
			.from(cards)
			.where(eq(cards.status, 'queued'))
			.orderBy(asc(cards.id))
			.limit(1)
			.for('update', { skipLocked: true })
		if (!card) return null
		const log = deps.log.child({ cardId: card.id, campaignId: card.campaignId })

		// The person may have opted out, or been mailed elsewhere, since the card was approved.
		const reason = blockReason(card.personKey, card.address as Address | null, await loadSuppressionState(tx), now)
		if (reason) {
			await tx
				.update(cards)
				.set({ status: 'blocked_at_send', blockReason: reason, statusChangedAt: now })
				.where(eq(cards.id, card.id))
			await audit(tx, {
				actor: worker,
				action: 'card.blocked_at_send',
				entityType: 'card',
				entityId: card.id,
				decision: 'blocked',
				reason,
				before: { status: 'queued' },
				after: { status: 'blocked_at_send' },
			})
			log.warn({ reason }, 'card blocked at send')
			return 'blocked'
		}

		const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, card.campaignId))
		const [template] = await tx
			.select()
			.from(templates)
			.where(eq(templates.id, card.variant === 'B' ? campaign!.templateBId : campaign!.templateAId))
		const body = postcardBody(card, template!.body)
		const attempts: Attempt[] = []
		let last = 0

		try {
			const result = await retry(
				(n) => {
					last = n
					return submitPostcard(deps.mail, card.idempotencyKey!, body)
				},
				{
					...deps.retry,
					onRetry: ({ attempt, delayMs, error }) => {
						attempts.push(attemptRow(card.id, attempt, error, delayMs, deps.clock()))
						log.warn({ attempt, delayMs, cause: describe(error) }, 'mail submission failed, retrying')
					},
				},
			)
			attempts.push({
				cardId: card.id,
				n: last,
				outcome: 'ok',
				httpStatus: result.httpStatus,
				delayMs: null,
				error: null,
				at: deps.clock(),
			})
			await tx.insert(submissionAttempts).values(attempts)
			await tx
				.update(cards)
				.set({ status: 'submitted', mailId: result.id, submittedAt: now, statusChangedAt: now })
				.where(eq(cards.id, card.id))
			await audit(tx, {
				actor: worker,
				action: 'card.submitted',
				entityType: 'card',
				entityId: card.id,
				before: { status: 'queued' },
				after: { status: 'submitted' },
				result: { mail_id: result.id, attempts: last },
			})
			// Webhooks for this postcard may have arrived before this transaction committed.
			await applyStoredEvents(tx, result.id, now)
			log.info({ mailId: result.id, attempts: last }, 'card submitted')
			return 'submitted'
		} catch (error) {
			attempts.push(attemptRow(card.id, last, error, null, deps.clock()))
			await tx.insert(submissionAttempts).values(attempts)
			await tx
				.update(cards)
				.set({ status: 'failed', sendError: describe(error).slice(0, 500), statusChangedAt: now })
				.where(eq(cards.id, card.id))
			await audit(tx, {
				actor: worker,
				action: 'card.failed',
				entityType: 'card',
				entityId: card.id,
				reason: error instanceof HttpError ? `http_${error.status}` : 'transport_error',
				before: { status: 'queued' },
				after: { status: 'failed' },
				result: { attempts: last, error: describe(error).slice(0, 200) },
			})
			log.error({ attempts: last, cause: describe(error) }, 'card failed to send')
			return 'failed'
		}
	})
}

export async function processQueue(deps: SendDeps) {
	const summary = { submitted: 0, blocked: 0, failed: 0 }
	for (let outcome = await processOne(deps); outcome; outcome = await processOne(deps)) summary[outcome]++
	return summary
}

export function startSendWorker(deps: SendDeps, intervalMs = 500) {
	let stopped = false
	const pause = () => new Promise((resolve) => setTimeout(resolve, intervalMs))
	void (async () => {
		while (!stopped) {
			try {
				if (!(await processOne(deps))) await pause()
			} catch (error) {
				deps.log.error({ cause: describe(error) }, 'send worker error')
				await pause()
			}
		}
	})()
	return { stop: () => (stopped = true) }
}

// --- Webhooks ------------------------------------------------------------------------------------------

const MAIL_STATUSES = ['submitted', 'printed', 'mailed', 'delivered', 'returned'] as const
type MailStatus = (typeof MAIL_STATUSES)[number]
const RANK: Record<MailStatus, number> = { submitted: 1, printed: 2, mailed: 3, delivered: 4, returned: 4 }
const ADVANCEABLE = ['submitted', 'printed', 'mailed'] as const

// Statuses only move forward; delivered and returned are both final. mailed_at comes from the mailed event alone.
async function applyMailEvent(
	tx: Executor,
	event: { mailId: string; status: MailStatus; occurredAt: Date },
	now: Date,
) {
	if (event.status === 'mailed') {
		await tx
			.update(cards)
			.set({ mailedAt: event.occurredAt })
			.where(and(eq(cards.mailId, event.mailId), isNull(cards.mailedAt)))
	}
	const from = ADVANCEABLE.filter((status) => RANK[status] < RANK[event.status])
	if (from.length === 0) return
	await tx
		.update(cards)
		.set({ status: event.status, statusChangedAt: now })
		.where(and(eq(cards.mailId, event.mailId), inArray(cards.status, from)))
}

async function applyStoredEvents(tx: Executor, mailId: string, now: Date) {
	const events = await tx
		.select()
		.from(mailEvents)
		.where(and(eq(mailEvents.mailId, mailId), eq(mailEvents.signatureOk, true)))
	for (const event of events.sort((a, b) => RANK[a.status as MailStatus] - RANK[b.status as MailStatus])) {
		await applyMailEvent(tx, { mailId, status: event.status as MailStatus, occurredAt: event.occurredAt! }, now)
	}
}

const eventSchema = z.object({
	event_id: z.string().min(1),
	mail_id: z.string().min(1),
	status: z.enum(MAIL_STATUSES),
	occurred_at: z.iso.datetime({ offset: true }),
})
export const SIGNATURE_TOLERANCE_SECONDS = 300

export function verifySignature(header: string | undefined, rawBody: string, secret: string, now: Date) {
	const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '')
	if (!match) return false
	const [, t, v1] = match
	if (Math.abs(now.getTime() / 1000 - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) return false
	const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest()
	return timingSafeEqual(expected, Buffer.from(v1!, 'hex'))
}

export async function receiveMailWebhook(
	deps: { db: Db; log: Logger; clock: Clock; webhookSecret: string },
	input: { rawBody: string; signature: string | undefined },
): Promise<{ status: 200 | 400 | 401; body: Record<string, unknown> }> {
	const now = deps.clock()
	let payload: unknown
	try {
		payload = JSON.parse(input.rawBody)
	} catch {
		payload = { raw: input.rawBody.slice(0, 2000) }
	}
	const event = eventSchema.safeParse(payload)
	const signatureOk = verifySignature(input.signature, input.rawBody, deps.webhookSecret, now)

	if (!signatureOk) {
		await deps.db.insert(mailEvents).values({
			providerEventId: null,
			mailId: event.success ? event.data.mail_id : null,
			status: event.success ? event.data.status : null,
			occurredAt: event.success ? new Date(event.data.occurred_at) : null,
			receivedAt: now,
			payload: payload,
			signatureOk: false,
		})
		deps.log.warn({ eventId: event.success ? event.data.event_id : null }, 'mail webhook rejected: bad signature')
		return { status: 401, body: { error: 'Invalid signature' } }
	}
	if (!event.success) return { status: 400, body: { error: 'Unexpected payload' } }

	const { event_id: eventId, mail_id: mailId, status } = event.data
	const occurredAt = new Date(event.data.occurred_at)
	return deps.db.transaction(async (tx) => {
		const [stored] = await tx
			.insert(mailEvents)
			.values({
				providerEventId: eventId,
				mailId,
				status,
				occurredAt,
				receivedAt: now,
				payload: payload,
				signatureOk: true,
			})
			.onConflictDoNothing({ target: mailEvents.providerEventId })
			.returning()
		if (!stored) {
			deps.log.info({ eventId }, 'duplicate mail webhook ignored')
			return { status: 200 as const, body: { duplicate: true } }
		}
		const [card] = await tx.select({ id: cards.id }).from(cards).where(eq(cards.mailId, mailId))
		if (!card) {
			// Kept: the worker applies it once its submission commits, if the mail id is ours at all.
			deps.log.warn({ eventId, mailId }, 'mail webhook for an unknown mail id')
			return { status: 200 as const, body: { unknownMailId: true } }
		}
		await applyMailEvent(tx, { mailId, status, occurredAt }, now)
		deps.log.info({ eventId, mailId, status, cardId: card.id }, 'mail webhook applied')
		return { status: 200 as const, body: { applied: true } }
	})
}

// --- Suppression ---------------------------------------------------------------------------------------

export async function addOptOut(
	deps: Pick<SendDeps, 'db' | 'clock'>,
	input: { email: string; source: string; actor: UserActor; requestId?: string },
) {
	const key = personKey(input.email)
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) throw new DomainError('That does not look like an email address.')
	return deps.db.transaction(async (tx) => {
		const [added] = await tx
			.insert(suppressions)
			.values({
				personKeyHash: personKeyHash(key),
				reason: 'opt_out',
				source: input.source.trim() || 'added by hand',
				createdBy: input.actor.id,
				at: deps.clock(),
			})
			.onConflictDoNothing()
			.returning()
		if (!added) return { added: false }
		await audit(tx, {
			actor: input.actor,
			action: 'suppression.added',
			entityType: 'suppression',
			entityId: added.id,
			reason: 'opt_out',
			result: { source: added.source },
			requestId: input.requestId,
		})
		return { added: true }
	})
}
