import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createFakeWorld } from './app.ts'

const secret = 'test-webhook-secret'
const postcard = (cardId: number, line1 = '19 Quarry Road') => ({
	to: { name: 'Laura Cooper', line1, line2: null, city: 'Cardiff', postcode: 'CF22 6AD', country: 'GB' },
	from: { name: 'Lumina', line1: '1 Example Street', line2: null, city: 'London', postcode: 'EC1A 1AA', country: 'GB' },
	front_html: '<p>Lumina</p>',
	back_html: '<p>Hello</p>',
	metadata: { card_id: cardId },
})

function setup(overrides: Parameters<typeof createFakeWorld>[0] = {}) {
	const delivered: { body: Record<string, string>; signature: string }[] = []
	let failNext = 0
	const world = createFakeWorld({
		controls: true,
		appUrl: 'http://app',
		webhookSecret: secret,
		sleep: () => Promise.resolve(),
		deliver: async (request) => {
			if (failNext > 0) {
				failNext--
				return new Response('down', { status: 503 })
			}
			delivered.push({
				body: (await request.json()) as Record<string, string>,
				signature: request.headers.get('x-signature') ?? '',
			})
			return new Response('ok')
		},
		...overrides,
	})
	const submit = (key: string, body: unknown) =>
		world.app.fetch(
			new Request('http://fake/v1/postcards', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
				body: JSON.stringify(body),
			}),
		)
	return { world, delivered, submit, failNextDeliveries: (n: number) => (failNext = n) }
}

describe('fake print-and-mail API', () => {
	it('creates a postcard once per Idempotency-Key and replays the response for a repeat', async () => {
		const { submit, world } = setup()
		const first = await submit('k1', postcard(1))
		expect(first.status).toBe(201)
		const created = (await first.json()) as { id: string; status: string }
		expect(created.status).toBe('submitted')

		const repeat = await submit('k1', postcard(1))
		expect(repeat.status).toBe(200)
		await expect(repeat.json()).resolves.toEqual(created)

		const calls = (await (await world.app.fetch(new Request('http://fake/__calls'))).json()) as {
			submissions: unknown[]
			postcards: unknown[]
		}
		expect(calls.submissions).toHaveLength(2)
		expect(calls.postcards).toHaveLength(1)
	})

	it('refuses a reused key with a different body, and an address without a street', async () => {
		const { submit } = setup()
		await submit('k1', postcard(1))
		const reused = await submit('k1', postcard(2))
		expect(reused.status).toBe(422)
		await expect(reused.json()).resolves.toMatchObject({ error: { code: 'idempotency_key_reused' } })
		expect((await submit('k2', postcard(3, ''))).status).toBe(422)
	})

	it('in timeout_once mode creates the postcard but answers too late, then replays it', async () => {
		const sleeps: number[] = []
		const { submit, world } = setup({ stall: (ms) => (sleeps.push(ms), Promise.resolve()) })
		await world.app.fetch(
			new Request('http://fake/__control', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mode: 'timeout_once' }),
			}),
		)
		const slow = await submit('k1', postcard(1))
		expect(sleeps).toContain(5000)
		const fast = await submit('k1', postcard(1))
		expect(await fast.json()).toEqual(await slow.json())
	})

	it('sends signed webhooks in order and redelivers after a failure', async () => {
		const { submit, world, delivered, failNextDeliveries } = setup({ returnedRate: 0 })
		failNextDeliveries(2)
		const { id } = (await (await submit('k1', postcard(1))).json()) as { id: string }
		await world.idle()

		expect(delivered.map((event) => event.body.status)).toEqual(['submitted', 'printed', 'mailed', 'delivered'])
		for (const event of delivered) {
			expect(event.body.mail_id).toBe(id)
			const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(event.signature)!
			expect(v1).toBe(
				createHmac('sha256', secret)
					.update(`${t}.${JSON.stringify(event.body)}`)
					.digest('hex'),
			)
		}
	})

	it('can shuffle and duplicate events, like real providers', async () => {
		const { submit, world, delivered } = setup({ rng: () => 0.01 })
		await world.app.fetch(
			new Request('http://fake/__control', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ duplicate_rate: 1, shuffle: true }),
			}),
		)
		await submit('k1', postcard(1))
		await world.idle()
		expect(delivered).toHaveLength(8)
		expect(new Set(delivered.map((event) => event.body.event_id)).size).toBe(4)
	})

	it('hides the controls unless they are enabled', async () => {
		const world = createFakeWorld({ controls: false })
		expect((await world.app.fetch(new Request('http://fake/__calls'))).status).toBe(404)
	})
})
