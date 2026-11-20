import { beforeAll, describe, expect, it } from 'vitest'
import { runIngestion } from '../pipeline/ingest/index.ts'
import { seedHistory } from '../seed/history.ts'
import { seed } from '../seed/seed.ts'
import { call, createTestApp, loginAs, testDeps, type FetchApp } from '../test/app.ts'
import { useTestDb } from '../test/db.ts'

const now = new Date('2026-11-20T12:00:00Z')

describe('campaigns API', () => {
	const t = useTestDb()
	let app: FetchApp
	let rep: string
	let lead: string
	let body: { name: string; topN: number; templateAId: number; templateBId: number }

	beforeAll(async () => {
		await seed(t.db, { now })
		const deps = testDeps(t.db, { clock: () => now })
		for (const provider of ['apollo', 'factset', 'clay'] as const) await runIngestion(deps, provider, 'system:test')
		await seedHistory(t.db, now)
		app = createTestApp(t.db, { clock: () => now })
		rep = await loginAs(app, 'usr_rep_tom')
		lead = await loginAs(app, 'usr_lead_maya')
		const { templates } = (await (await call(app, '/api/templates', { cookie: rep })).json()) as {
			templates: { id: number; variant: string }[]
		}
		body = {
			name: 'Top 50',
			topN: 50,
			templateAId: templates.find((tpl) => tpl.variant === 'A')!.id,
			templateBId: templates.find((tpl) => tpl.variant === 'B')!.id,
		}
	})

	it('requires an Idempotency-Key to create a campaign', async () => {
		const response = await call(app, '/api/campaigns', { method: 'POST', cookie: rep, body })
		expect(response.status).toBe(400)
		await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/Idempotency-Key/) as string })
	})

	it('creates once per key: 201, then 200 with the same campaign', async () => {
		const first = await call(app, '/api/campaigns', {
			method: 'POST',
			cookie: rep,
			body,
			headers: { 'Idempotency-Key': 'abc' },
		})
		expect(first.status).toBe(201)
		const { campaign } = (await first.json()) as { campaign: { id: number } }
		const again = await call(app, '/api/campaigns', {
			method: 'POST',
			cookie: rep,
			body,
			headers: { 'Idempotency-Key': 'abc' },
		})
		expect(again.status).toBe(200)
		await expect(again.json()).resolves.toMatchObject({ campaign: { id: campaign.id } })

		const detail = (await (await call(app, `/api/campaigns/${campaign.id}`, { cookie: rep })).json()) as {
			cards: unknown[]
			summary: { eligible: number; blocked: Record<string, number> }
		}
		expect(detail.cards).toHaveLength(50)
		expect(detail.summary.eligible).toBe(39)
		expect(Object.values(detail.summary.blocked).reduce((a, b) => a + b, 0)).toBe(11)
	})

	it('lets a lead approve and refuses a rep with a clear message', async () => {
		const { campaigns } = (await (await call(app, '/api/campaigns', { cookie: rep })).json()) as {
			campaigns: { id: number; name: string }[]
		}
		const campaign = campaigns.find((row) => row.name === 'Top 50')!
		const { cards } = (await (await call(app, `/api/campaigns/${campaign.id}`, { cookie: rep })).json()) as {
			cards: { id: number; status: string }[]
		}
		const draft = cards.find((card) => card.status === 'draft')!

		const denied = await call(app, `/api/cards/${draft.id}/approve`, { method: 'POST', cookie: rep })
		expect(denied.status).toBe(403)
		await expect(denied.json()).resolves.toMatchObject({ error: expect.stringMatching(/Only a sales lead/) as string })
		expect(
			(await call(app, `/api/campaigns/${campaign.id}/approve-eligible`, { method: 'POST', cookie: rep })).status,
		).toBe(403)

		const approved = await call(app, `/api/cards/${draft.id}/approve`, { method: 'POST', cookie: lead })
		await expect(approved.json()).resolves.toMatchObject({ changed: true, card: { status: 'approved' } })
		const repeat = await call(app, `/api/cards/${draft.id}/approve`, { method: 'POST', cookie: lead })
		await expect(repeat.json()).resolves.toMatchObject({ changed: false, card: { status: 'approved' } })

		const rejected = await call(
			app,
			`/api/cards/${cards.find((card) => card.status === 'draft' && card.id !== draft.id)!.id}/reject`,
			{ method: 'POST', cookie: rep, body: { reason: '' } },
		)
		expect(rejected.status).toBe(400)
	})
})
