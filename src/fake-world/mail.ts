import { retry } from '#server/lib/retry.ts'
import { Hono } from 'hono'
import { createHash, createHmac } from 'node:crypto'

// Loosely modelled on Lob's postcard API, with the brief's statuses. Lives in fake-world so timeouts and
// webhooks are real HTTP.

export interface MailOptions {
	appUrl: string
	webhookSecret: string
	deliver: (request: Request) => Promise<Response>
	sleep: (ms: number) => Promise<void>
	// How the timeout modes stall their answer. Separate from sleep, which paces webhooks and their retries.
	stall: (ms: number) => Promise<void>
	rng: () => number
	now: () => Date
	timeoutDelayMs: number
	returnedRate: number
	controls: boolean
}

type Mode = 'normal' | 'timeout_once' | 'timeout_always' | 'error_500_once'
type Address = { name?: unknown; line1?: unknown; city?: unknown; postcode?: unknown; country?: unknown }

interface Postcard {
	id: string
	key: string
	bodyHash: string
	response: { id: string; status: 'submitted' }
	cardId: unknown
	createdAt: string
}

const STATUSES = ['submitted', 'printed', 'mailed'] as const
const text = (value: unknown) => typeof value === 'string' && value.trim() !== ''

export function mailRoutes(options: MailOptions) {
	const app = new Hono()
	const postcards = new Map<string, Postcard>()
	const submissions: { key: string | null; cardId: unknown; at: string }[] = []
	const pending = new Set<Promise<unknown>>()
	const control = { mode: 'normal' as Mode, webhookDelayMs: 0, duplicateRate: 0, shuffle: false }

	const sign = (body: string) => {
		const t = Math.floor(options.now().getTime() / 1000)
		return `t=${t},v1=${createHmac('sha256', options.webhookSecret).update(`${t}.${body}`).digest('hex')}`
	}

	// Real providers redeliver anything that does not get a 2xx, with backoff.
	const deliver = (event: Record<string, string>) =>
		retry(
			async () => {
				const body = JSON.stringify(event)
				const response = await options.deliver(
					new Request(`${options.appUrl}/webhooks/mail`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json', 'X-Signature': sign(body) },
						body,
					}),
				)
				if (!response.ok) throw Object.assign(new Error(`webhook answered ${response.status}`), { retryable: true })
			},
			{ isRetryable: () => true, maxAttempts: 8, baseMs: 200, capMs: 5000, rng: options.rng, sleep: options.sleep },
		).catch(() => undefined)

	function schedule(postcard: Postcard) {
		const hash = parseInt(createHash('sha256').update(postcard.id).digest('hex').slice(0, 8), 16) / 0xffffffff
		const final = hash < options.returnedRate ? 'returned' : 'delivered'
		const base = options.now().getTime()
		let events = [...STATUSES, final].map((status, index) => ({
			event_id: `evt_${postcard.id}_${status}`,
			mail_id: postcard.id,
			status,
			occurred_at: new Date(base + index * control.webhookDelayMs).toISOString(),
		}))
		events = events.flatMap((event) => (options.rng() < control.duplicateRate ? [event, event] : [event]))
		if (control.shuffle)
			events = events
				.map((event) => ({ event, sort: options.rng() }))
				.sort((a, b) => a.sort - b.sort)
				.map(({ event }) => event)

		const run = (async () => {
			for (const event of events) {
				if (control.webhookDelayMs) await options.sleep(control.webhookDelayMs)
				await deliver(event)
			}
		})()
		pending.add(run)
		void run.finally(() => pending.delete(run))
	}

	app.post('/v1/postcards', async (context) => {
		const key = context.req.header('idempotency-key') ?? null
		const raw = await context.req.text()
		let body: { to?: Address; from?: Address; metadata?: { card_id?: unknown } }
		try {
			body = JSON.parse(raw) as typeof body
		} catch {
			return context.json({ error: { code: 'invalid_json', message: 'Body is not JSON' } }, 400)
		}
		submissions.push({ key, cardId: body.metadata?.card_id, at: options.now().toISOString() })

		if (!key)
			return context.json(
				{ error: { code: 'idempotency_key_required', message: 'Send an Idempotency-Key header' } },
				400,
			)
		const bodyHash = createHash('sha256').update(raw).digest('hex')
		const existing = postcards.get(key)
		if (existing) {
			if (existing.bodyHash !== bodyHash) {
				return context.json(
					{ error: { code: 'idempotency_key_reused', message: 'This key was used with a different body' } },
					422,
				)
			}
			return context.json(existing.response, 200)
		}

		if (control.mode === 'error_500_once') {
			control.mode = 'normal'
			return context.json({ error: { code: 'internal_error', message: 'Temporary failure' } }, 500)
		}
		const to = body.to ?? {}
		const missing = (['name', 'line1', 'city', 'postcode', 'country'] as const).filter((field) => !text(to[field]))
		if (missing.length) {
			return context.json(
				{ error: { code: 'invalid_address', message: `to.${missing.join(', to.')} is required` } },
				422,
			)
		}

		const id = `psc_${String(postcards.size + 1).padStart(6, '0')}`
		const postcard: Postcard = {
			id,
			key,
			bodyHash,
			response: { id, status: 'submitted' },
			cardId: body.metadata?.card_id,
			createdAt: options.now().toISOString(),
		}
		postcards.set(key, postcard)
		schedule(postcard)

		// Timeout modes create the postcard first and only then stall, like a provider whose response is lost.
		if (control.mode === 'timeout_once' || control.mode === 'timeout_always') {
			if (control.mode === 'timeout_once') control.mode = 'normal'
			await options.stall(options.timeoutDelayMs)
		}
		return context.json(postcard.response, 201)
	})

	if (options.controls) {
		app.post('/__control', async (context) => {
			const body = (await context.req.json().catch(() => ({}))) as {
				mode?: Mode
				webhook_delay_ms?: number
				duplicate_rate?: number
				shuffle?: boolean
			}
			if (body.mode) control.mode = body.mode
			if (body.webhook_delay_ms !== undefined) control.webhookDelayMs = body.webhook_delay_ms
			if (body.duplicate_rate !== undefined) control.duplicateRate = body.duplicate_rate
			if (body.shuffle !== undefined) control.shuffle = body.shuffle
			return context.json({ control })
		})
		app.get('/__calls', (context) =>
			context.json({
				submissions,
				postcards: [...postcards.values()].map(({ id, key, cardId, createdAt }) => ({ id, key, cardId, createdAt })),
			}),
		)
	}

	return {
		app,
		// Resolves once every scheduled webhook has been delivered (or given up on). For tests.
		idle: async () => {
			while (pending.size) await Promise.allSettled([...pending])
		},
	}
}
