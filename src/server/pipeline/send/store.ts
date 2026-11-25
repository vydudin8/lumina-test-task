import { and, asc, count, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { audit, systemActor } from '../../audit.ts'
import type { Db, Executor } from '../../db/client.ts'
import { campaigns, cards, contacts, mailEvents, submissionAttempts, suppressions, templates } from '../../db/schema.ts'
import { stoppableSleep, type Clock } from '../../lib/clock.ts'
import { DomainError, failureText } from '../../lib/errors.ts'
import { HttpError, retry, type RetryOptions } from '../../lib/retry.ts'
import type { Logger } from '../../log.ts'
import { personKey, personKeyHash } from '../../policy/person-key.ts'
import { blockReason } from '../campaign/core.ts'
import { loadPersonSuppression } from '../campaign/store.ts'
import type { Address } from '../resolve/core.ts'
import {
	getPostcard,
	MAIL_STATUSES,
	postcardBody,
	submitPostcard,
	type MailClient,
	type MailStatus,
} from './mail-client.ts'

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
const reconciler = systemActor('mail-reconciler')

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
			before: { launchedAt: campaign.launchedAt },
			after: { launchedAt: updated!.launchedAt },
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

type SendOutcome = 'submitted' | 'blocked' | 'failed' | 'unconfirmed'

// Takes one queued card under FOR UPDATE SKIP LOCKED, re-checks it, submits it and records the outcome, all in one
// transaction. shortcut: the row stays locked during the HTTP call and its retries; fine for one worker at demo
// volume, move to a claim column plus a lease before running several workers.
export async function processOne(deps: SendDeps): Promise<SendOutcome | null> {
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
		try {
			// A savepoint: when this card breaks on our side (a constraint, a bug), its work is undone but the row lock and
			// the transaction survive, so the card leaves the queue instead of being claimed again forever, ahead of the rest.
			return await tx.transaction((savepoint) => submitCard(deps, savepoint, card, log, now))
		} catch (error) {
			// The printer may already have the postcard, so unconfirmed, like a lost answer: a lead retries it with the same
			// key once the cause is fixed. With the database connection gone this update fails too, and the card stays queued.
			const cause = failureText(error)
			await tx
				.update(cards)
				.set({ status: 'unconfirmed', sendError: cause, statusChangedAt: now })
				.where(eq(cards.id, card.id))
			await audit(tx, {
				actor: worker,
				action: 'card.send_unconfirmed',
				entityType: 'card',
				entityId: card.id,
				reason: 'internal_error',
				before: { status: 'queued' },
				after: { status: 'unconfirmed' },
				result: { error: cause },
			})
			log.error({ cause }, 'card send broke on our side; marked unconfirmed')
			return 'unconfirmed'
		}
	})
}

async function submitCard(
	deps: SendDeps,
	tx: Executor,
	card: typeof cards.$inferSelect,
	log: Logger,
	now: Date,
): Promise<SendOutcome> {
	// A queued card was approved, so it has a recipient (cards_recipient_present: only no-contact cards lack one).
	const personKey = card.personKey!
	const recipient = card.recipient!
	// The person may have opted out, or been mailed elsewhere, since the card was approved.
	const reason = blockReason(personKey, card.address as Address | null, await loadPersonSuppression(tx, personKey), now)
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
		.where(eq(templates.id, (card.variant === 'B' ? campaign!.templateBId : null) ?? campaign!.templateAId))
	// cards_line_present: a queued card was approved, so its line is written.
	const body = postcardBody({ ...card, recipient, personalLine: card.personalLine! }, template!.body)
	const attempts: Attempt[] = []
	// Attempts keep counting across retries of the same card (unique on card_id, n).
	const [{ prior }] = (await tx
		.select({ prior: count() })
		.from(submissionAttempts)
		.where(eq(submissionAttempts.cardId, card.id))) as [{ prior: number }]
	let last = 0

	// Only the HTTP call: a database error after the printer answered is not the printer's failure (processOne handles it).
	let result: Awaited<ReturnType<typeof submitPostcard>>
	try {
		result = await retry(
			(n) => {
				last = n
				return submitPostcard(deps.mail, card.idempotencyKey!, body)
			},
			{
				...deps.retry,
				onRetry: ({ attempt, delayMs, error }) => {
					attempts.push(attemptRow(card.id, prior + attempt, error, delayMs, deps.clock()))
					log.warn({ attempt, delayMs, cause: describe(error) }, 'mail submission failed, retrying')
				},
			},
		)
	} catch (error) {
		attempts.push(attemptRow(card.id, prior + last, error, null, deps.clock()))
		await tx.insert(submissionAttempts).values(attempts)
		// A 4xx is a definite "no". Anything else (timeouts, 5xx, network) leaves us not knowing whether the postcard
		// exists, so the card is unconfirmed: held back like a sent card and retried with the same key, never re-keyed.
		const definite = error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 429
		const status = definite ? 'failed' : 'unconfirmed'
		await tx
			.update(cards)
			.set({ status, sendError: describe(error).slice(0, 500), statusChangedAt: now })
			.where(eq(cards.id, card.id))
		await audit(tx, {
			actor: worker,
			action: definite ? 'card.failed' : 'card.send_unconfirmed',
			entityType: 'card',
			entityId: card.id,
			reason: error instanceof HttpError ? `http_${error.status}` : 'no_response',
			before: { status: 'queued' },
			after: { status },
			result: { attempts: last, error: describe(error).slice(0, 200) },
		})
		log.error(
			{ attempts: last, cause: describe(error), status },
			definite ? 'card failed to send' : 'card submission unconfirmed',
		)
		return definite ? 'failed' : 'unconfirmed'
	}
	attempts.push({
		cardId: card.id,
		n: prior + last,
		outcome: 'ok',
		httpStatus: result.httpStatus,
		delayMs: null,
		error: null,
		at: deps.clock(),
	})
	await tx.insert(submissionAttempts).values(attempts)
	// Serialises with the webhook handler for this mail id (see receiveMailWebhook).
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${result.id}))`)
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
}

export async function processQueue(deps: SendDeps) {
	const summary = { submitted: 0, blocked: 0, failed: 0, unconfirmed: 0 }
	for (let outcome = await processOne(deps); outcome; outcome = await processOne(deps)) summary[outcome]++
	return summary
}

export interface WorkerOptions {
	intervalMs?: number
	// Consecutive unconfirmed cards that mean the provider is down, and how long to leave it alone then.
	failureThreshold?: number
	cooldownMs?: number
	sleep?: (ms: number) => Promise<void>
}

// Circuit breaker: with the provider down every card burns all its attempts and ends unconfirmed, and each one is a
// manual retry. After a run of them the worker stops claiming cards; they stay queued with no attempts used. Any
// answer from the provider (submitted, failed) or no need to ask it (blocked) closes the circuit again. A card that
// breaks on our side ends unconfirmed too, so a bug that hits every card pauses the queue the same way.
export function startSendWorker(deps: SendDeps, options: WorkerOptions = {}) {
	const { intervalMs = 500, failureThreshold = 3, cooldownMs = 60_000 } = options
	let stopped = false
	const stopping = new AbortController()
	// stop() ends a cool-down at once, so a shutdown waits for the card in hand, never for the pause.
	const sleep = options.sleep ?? stoppableSleep(stopping.signal)
	let unconfirmed = 0
	const done = (async () => {
		while (!stopped) {
			try {
				const outcome = await processOne(deps)
				if (!outcome) {
					await sleep(intervalMs)
					continue
				}
				// A blocked card never reached the provider, so it says nothing about whether the provider is up.
				if (outcome === 'unconfirmed') unconfirmed++
				else if (outcome !== 'blocked') unconfirmed = 0
				if (outcome !== 'unconfirmed' || unconfirmed < failureThreshold) continue
				deps.log.warn({ unconfirmed, cooldownMs }, 'cards keep ending unconfirmed; send worker paused')
				await sleep(cooldownMs)
				deps.log.info('send worker resumed')
				// Half-open: the next card is a probe, and one more unconfirmed opens the circuit again.
				unconfirmed = failureThreshold - 1
			} catch (error) {
				deps.log.error({ cause: failureText(error) }, 'send worker error')
				await sleep(intervalMs)
			}
		}
	})()
	return {
		stop: () => {
			stopped = true
			stopping.abort()
		},
		done,
	}
}

// Lead only. Puts an unconfirmed card back in the queue with its original Idempotency-Key, so the provider returns
// the postcard it may already have instead of printing a second one.
export async function retrySend(
	deps: Pick<SendDeps, 'db' | 'clock'>,
	input: { cardId: number; actor: UserActor; requestId?: string },
) {
	if (input.actor.role !== 'lead') throw new DomainError('Only a sales lead can retry a send.', 403)
	const now = deps.clock()
	return deps.db.transaction(async (tx) => {
		const [card] = await tx
			.update(cards)
			.set({ status: 'queued', sendError: null, statusChangedAt: now })
			.where(and(eq(cards.id, input.cardId), eq(cards.status, 'unconfirmed')))
			.returning()
		if (!card) {
			const [current] = await tx.select().from(cards).where(eq(cards.id, input.cardId))
			if (!current) throw new DomainError('Card not found.', 404)
			return { changed: false, card: current }
		}
		await audit(tx, {
			actor: input.actor,
			action: 'card.send_retried',
			entityType: 'card',
			entityId: card.id,
			before: { status: 'unconfirmed' },
			after: { status: 'queued' },
			result: { idempotencyKey: card.idempotencyKey },
			requestId: input.requestId,
		})
		return { changed: true, card }
	})
}

// Lead only. retrySend for every unconfirmed card of one campaign, in one transaction.
export async function retryUnconfirmed(
	deps: Pick<SendDeps, 'db' | 'clock'>,
	input: { campaignId: number; actor: UserActor; requestId?: string },
) {
	if (input.actor.role !== 'lead') throw new DomainError('Only a sales lead can retry a send.', 403)
	const now = deps.clock()
	return deps.db.transaction(async (tx) => {
		const requeued = await tx
			.update(cards)
			.set({ status: 'queued', sendError: null, statusChangedAt: now })
			.where(and(eq(cards.campaignId, input.campaignId), eq(cards.status, 'unconfirmed')))
			.returning({ id: cards.id, idempotencyKey: cards.idempotencyKey })
		for (const card of requeued) {
			await audit(tx, {
				actor: input.actor,
				action: 'card.send_retried',
				entityType: 'card',
				entityId: card.id,
				before: { status: 'unconfirmed' },
				after: { status: 'queued' },
				result: { idempotencyKey: card.idempotencyKey, bulk: true },
				requestId: input.requestId,
			})
		}
		return { requeued: requeued.length }
	})
}

// --- Webhooks ------------------------------------------------------------------------------------------

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
		const result = await recordMailEvent(tx, { eventId, mailId, status, occurredAt, payload, source: 'webhook' }, now)
		if (result.outcome === 'duplicate') {
			deps.log.info({ eventId }, 'duplicate mail webhook ignored')
			return { status: 200 as const, body: { duplicate: true } }
		}
		if (result.outcome === 'unknown_mail_id') {
			// Kept: the worker applies it once its submission commits, if the mail id is ours at all.
			deps.log.warn({ eventId, mailId }, 'mail webhook for an unknown mail id')
			return { status: 200 as const, body: { unknownMailId: true } }
		}
		deps.log.info({ eventId, mailId, status, cardId: result.cardId }, 'mail webhook applied')
		return { status: 200 as const, body: { applied: true } }
	})
}

// The worker holds this lock from receiving a mail id until it commits, so an event either finds the card or is stored
// before the worker replays stored events: it can never fall in between. Re-entrant within one transaction.
const lockMail = (tx: Executor, mailId: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${mailId}))`)

// The one way a provider event gets in, from a webhook or from reconciliation. The same provider_event_id arriving
// twice, by either route, is a duplicate.
async function recordMailEvent(
	tx: Executor,
	event: {
		eventId: string
		mailId: string
		status: MailStatus
		occurredAt: Date
		payload: unknown
		source: 'webhook' | 'reconcile'
	},
	now: Date,
): Promise<{ outcome: 'duplicate' } | { outcome: 'unknown_mail_id' } | { outcome: 'applied'; cardId: number }> {
	await lockMail(tx, event.mailId)
	const [stored] = await tx
		.insert(mailEvents)
		.values({
			providerEventId: event.eventId,
			mailId: event.mailId,
			status: event.status,
			occurredAt: event.occurredAt,
			receivedAt: now,
			payload: event.payload,
			signatureOk: true,
			source: event.source,
		})
		.onConflictDoNothing({ target: mailEvents.providerEventId })
		.returning({ id: mailEvents.id })
	if (!stored) return { outcome: 'duplicate' }
	const [card] = await tx.select({ id: cards.id }).from(cards).where(eq(cards.mailId, event.mailId))
	if (!card) return { outcome: 'unknown_mail_id' }
	await applyMailEvent(tx, event, now)
	return { outcome: 'applied', cardId: card.id }
}

// --- Reconciliation --------------------------------------------------------------------------------------
// Webhooks sent while we were down are gone (the provider gives up redelivering), so a card at the provider that has
// sat in one status for a while is asked about directly. Only submitted, printed and mailed: queued and unconfirmed
// cards are not at the provider (or we hold no mail id), the rest are final.

export async function reconcileMail(deps: SendDeps, input: { batch: number; staleAfterMs: number }) {
	const now = deps.clock()
	const cutoff = new Date(now.getTime() - input.staleAfterMs)
	const due = await deps.db
		.select({ id: cards.id, mailId: cards.mailId })
		.from(cards)
		.where(
			and(
				inArray(cards.status, ADVANCEABLE),
				isNotNull(cards.mailId),
				lt(cards.statusChangedAt, cutoff),
				or(isNull(cards.reconciledAt), lt(cards.reconciledAt, cutoff)),
			),
		)
		.orderBy(asc(cards.statusChangedAt), asc(cards.id))
		.limit(input.batch)

	const summary = { polled: 0, moved: 0, stopped: false }
	for (const { id: cardId, mailId } of due) {
		const log = deps.log.child({ cardId, mailId })
		let postcard: Awaited<ReturnType<typeof getPostcard>>
		try {
			postcard = await retry(() => getPostcard(deps.mail, mailId!), { ...deps.retry, maxAttempts: 3 })
		} catch (error) {
			const cardSpecific =
				error instanceof z.ZodError || (error instanceof HttpError && error.status < 500 && error.status !== 429)
			if (!cardSpecific) {
				// Rate limited or unreachable: every other card would fare the same. They stay due for the next tick.
				log.warn({ cause: describe(error) }, 'mail reconciliation stopped; provider not answering')
				summary.stopped = true
				break
			}
			// A 404 or an unreadable answer will not change by asking again soon.
			log.warn({ cause: describe(error) }, 'mail reconciliation could not read the postcard')
			await deps.db.update(cards).set({ reconciledAt: now }).where(eq(cards.id, cardId))
			summary.polled++
			continue
		}
		summary.polled++
		const moved = await deps.db.transaction(async (tx) => {
			await lockMail(tx, mailId!)
			const [before] = await tx.select({ status: cards.status }).from(cards).where(eq(cards.id, cardId))
			let recorded = 0
			for (const event of postcard.events) {
				const result = await recordMailEvent(
					tx,
					{
						eventId: event.event_id,
						mailId: mailId!,
						status: event.status,
						occurredAt: new Date(event.occurred_at),
						payload: { ...event, mail_id: mailId },
						source: 'reconcile',
					},
					now,
				)
				if (result.outcome === 'applied') recorded++
			}
			const [after] = await tx
				.update(cards)
				.set({ reconciledAt: now })
				.where(eq(cards.id, cardId))
				.returning({ status: cards.status })
			if (before!.status === after!.status) return false
			await audit(tx, {
				actor: reconciler,
				action: 'card.status_reconciled',
				entityType: 'card',
				entityId: cardId,
				before: { status: before!.status },
				after: { status: after!.status },
				result: { mail_id: mailId, events: recorded },
			})
			return true
		})
		if (moved) {
			summary.moved++
			log.info('card status reconciled with the provider')
		}
	}
	return summary
}

export function startMailReconciler(
	deps: SendDeps,
	options: { intervalMs: number; batch: number; staleAfterMs: number },
) {
	let stopped = false
	const stopping = new AbortController()
	const sleep = stoppableSleep(stopping.signal)
	const done = (async () => {
		while (!stopped) {
			try {
				await reconcileMail(deps, options)
			} catch (error) {
				deps.log.error({ cause: describe(error) }, 'mail reconciler error')
			}
			await sleep(options.intervalMs)
		}
	})()
	return {
		stop: () => {
			stopped = true
			stopping.abort()
		},
		done,
	}
}

// --- Suppression ---------------------------------------------------------------------------------------

export async function addOptOut(
	deps: Pick<SendDeps, 'db' | 'clock'>,
	input: { email: string; source: string; actor: UserActor; requestId?: string },
) {
	const key = personKey(input.email)
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) throw new DomainError('That does not look like an email address.')
	return deps.db.transaction(async (tx) => {
		// Only people we hold a contact for: an opt-out is recorded against someone we could actually mail.
		const [known] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.personKey, key)).limit(1)
		if (!known) throw new DomainError('No contact has that email address.', 404)
		const [added] = await tx
			.insert(suppressions)
			.values({
				personKeyHash: personKeyHash(key),
				reason: 'opt_out',
				source: input.source.trim() || 'added manually',
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
