import { and, desc, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { campaigns, cards, jobs, submissionAttempts } from '../db/schema.ts'
import { jobRunnerDeps } from '../job-handlers.ts'
import { JOB_KINDS, runPendingJobs } from '../jobs.ts'
import { createStubLlm } from '../llm/stub.ts'
import type { Llm } from '../llm/types.ts'
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
	// What the job runner does in the real server, run to the end.
	let runJobs: () => Promise<number>
	let body: { name: string; topN: number; templateAId: number; templateBId: number }

	beforeAll(async () => {
		await seed(t.db, { now })
		const deps = testDeps(t.db, { clock: () => now })
		for (const provider of ['apollo', 'factset', 'clay'] as const) await runIngestion(deps, provider, 'system:test')
		await seedHistory(t.db, now)
		app = createTestApp(t.db, { clock: () => now })
		runJobs = () => runPendingJobs(jobRunnerDeps(testDeps(t.db, { clock: () => now })))
		rep = await loginAs(app, 'usr_rep_tom')
		lead = await loginAs(app, 'usr_lead_maya')
		const { templates } = (await (await call(app, '/api/templates', { cookie: rep })).json()) as {
			templates: { id: number; name: string; body: string }[]
		}
		expect(templates.map(({ name }) => name)).toEqual(['Site demo day', 'Running costs', 'Zero-emission tenders'])
		expect(templates.map(({ id }) => id)).toEqual(templates.map(({ id }) => id).sort((a, b) => a - b))
		expect(Object.keys(templates[0]!).sort()).toEqual(['body', 'id', 'name'])
		body = { name: 'Top 50', topN: 50, templateAId: templates[0]!.id, templateBId: templates[1]!.id }
	})

	const create = async (key: string, name: string) => {
		const response = await call(app, '/api/campaigns', {
			method: 'POST',
			cookie: rep,
			body: { ...body, name },
			headers: { 'Idempotency-Key': key },
		})
		const { id } = ((await response.json()) as { campaign: { id: number } }).campaign
		await runJobs()
		return id
	}
	const detailOf = async (campaignId: number) =>
		(await (await call(app, `/api/campaigns/${campaignId}`, { cookie: rep })).json()) as {
			cards?: unknown
			templates: { id: number }[]
			summary: Record<string, unknown>
			activity?: unknown
		}
	interface CardRow {
		id: number
		status: string
		rank: number
		eligibility: string
		blockReason: string | null
		llmStatus: string | null
		variant: string | null
		approvedAt: string | null
		submittedAt: string | null
		companyId: number
		companyName: string | null
		attempts: { n: number; cardId: number }[]
	}
	interface CardsPage {
		total: number
		pageSize: number
		nextCursor: string | null
		counts: { views: Record<string, number>; variants: { A: number; B: number } }
		cards: CardRow[]
	}
	const cardsPage = async (campaignId: number, query = '') =>
		(await (await call(app, `/api/campaigns/${campaignId}/cards${query}`, { cookie: rep })).json()) as CardsPage
	// Every page of a campaign's cards, following the cursors.
	const allCards = async (campaignId: number, query = '') => {
		const pages: CardsPage[] = []
		for (let cursor = ''; pages.length < 50;) {
			const page = await cardsPage(campaignId, `${query || '?'}${query ? '&' : ''}cursor=${cursor}`)
			pages.push(page)
			if (!page.nextCursor) break
			cursor = page.nextCursor
		}
		return { pages, cards: pages.flatMap((page) => page.cards) }
	}
	const draftIds = async (campaignId: number) =>
		(await allCards(campaignId)).cards
			.filter((card) => card.status === 'draft')
			.sort((a, b) => a.rank - b.rank)
			.map((card) => card.id)
	interface Group {
		id: string
		action: string
		count: number
		cardIds: number[]
		events: { id: number; link: string | null }[]
	}
	interface Activity {
		total: number
		pageSize: number
		nextCursor: string | null
		groups: Group[]
		actions: string[]
		cards: { id: number; rank: number; companyName: string | null; status: string }[]
	}
	const activityOf = async (campaignId: number, query = '') =>
		(await (await call(app, `/api/campaigns/${campaignId}/activity${query}`, { cookie: rep })).json()) as Activity

	it('refuses two identical templates and a template that does not exist', async () => {
		const send = (overrides: object) =>
			call(app, '/api/campaigns', {
				method: 'POST',
				cookie: rep,
				body: { ...body, ...overrides },
				headers: { 'Idempotency-Key': 'bad-templates' },
			})
		const same = await send({ templateBId: body.templateAId })
		expect(same.status).toBe(400)
		await expect(same.json()).resolves.toEqual({ error: 'Pick two different templates.' })
		const missing = await send({ templateBId: 999_999 })
		expect(missing.status).toBe(400)
		await expect(missing.json()).resolves.toEqual({ error: 'That template does not exist.' })
	})

	it('requires an Idempotency-Key to create a campaign', async () => {
		const response = await call(app, '/api/campaigns', { method: 'POST', cookie: rep, body })
		expect(response.status).toBe(400)
		await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/Idempotency-Key/) as string })
	})

	it('creates once when two requests with the same key race: one campaign, one lines job', async () => {
		const create = () =>
			call(app, '/api/campaigns', { method: 'POST', cookie: rep, body, headers: { 'Idempotency-Key': 'race' } })
		const responses = await Promise.all([create(), create()])
		expect(responses.map((response) => response.status).sort()).toEqual([200, 201])
		const [a, b] = await Promise.all(
			responses.map(async (response) => ((await response.json()) as { campaign: { id: number } }).campaign.id),
		)
		expect(a).toBe(b)
		expect(await t.db.select().from(campaigns).where(eq(campaigns.idempotencyKey, 'race'))).toHaveLength(1)
		const lineJobs = await t.db
			.select()
			.from(jobs)
			.where(and(eq(jobs.kind, JOB_KINDS.lines), eq(jobs.key, String(a))))
		expect(lineJobs).toHaveLength(1)
		await runJobs()
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
		await runJobs()
		const again = await call(app, '/api/campaigns', {
			method: 'POST',
			cookie: rep,
			body,
			headers: { 'Idempotency-Key': 'abc' },
		})
		expect(again.status).toBe(200)
		await expect(again.json()).resolves.toMatchObject({ campaign: { id: campaign.id } })

		const detail = (await detailOf(campaign.id)) as unknown as {
			summary: { total: number; eligible: number; blocked: Record<string, number> }
		}
		expect(detail.summary.total).toBe(50)
		expect(detail.summary.eligible).toBe(39)
		expect(Object.values(detail.summary.blocked).reduce((a, b) => a + b, 0)).toBe(11)
		expect((await allCards(campaign.id)).cards).toHaveLength(50)
	})

	it('answers 201 before any line is written; the job writes them, and approving waits for them', async () => {
		const inner = createStubLlm({ hallucinateEvery: 0 })
		let calls = 0
		const llm: Llm = {
			...inner,
			generate: (request) => {
				calls++
				return inner.generate(request)
			},
		}
		const counted = createTestApp(t.db, { clock: () => now, llm })
		const response = await call(counted, '/api/campaigns', {
			method: 'POST',
			cookie: rep,
			body: { ...body, name: 'Background lines' },
			headers: { 'Idempotency-Key': 'background-lines' },
		})
		expect(response.status).toBe(201)
		const { campaign } = (await response.json()) as { campaign: { id: number } }
		expect(calls).toBe(0)

		const pending = (await detailOf(campaign.id)) as unknown as {
			summary: { eligible: number; linesPending: number }
			linesJob: { status: string }
		}
		expect(pending).toMatchObject({ summary: { eligible: 39, linesPending: 39 }, linesJob: { status: 'queued' } })
		const first = (await allCards(campaign.id)).cards.find((card) => card.eligibility === 'eligible')!
		expect(first).toMatchObject({ personalLine: null, lineSource: null })
		const refused = await call(counted, `/api/cards/${first.id}/approve`, { method: 'POST', cookie: lead })
		expect(refused.status).toBe(409)
		await expect(refused.json()).resolves.toMatchObject({
			error: expect.stringMatching(/still being written/) as string,
		})
		const early = await call(counted, `/api/campaigns/${campaign.id}/approve-eligible`, {
			method: 'POST',
			cookie: lead,
		})
		await expect(early.json()).resolves.toEqual({ approved: 0 })

		await runPendingJobs(jobRunnerDeps(testDeps(t.db, { clock: () => now, llm })))
		expect(calls).toBe(39)
		expect(await detailOf(campaign.id)).toMatchObject({
			summary: { linesPending: 0 },
			linesJob: { status: 'done', error: null },
		})
		const done = await call(counted, `/api/campaigns/${campaign.id}/approve-eligible`, { method: 'POST', cookie: lead })
		await expect(done.json()).resolves.toEqual({ approved: 39 })
	})

	it('lets a lead approve and refuses a rep with a clear message', async () => {
		const { campaigns } = (await (await call(app, '/api/campaigns', { cookie: rep })).json()) as {
			campaigns: { id: number; name: string }[]
		}
		const campaign = campaigns.find((row) => row.name === 'Top 50')!
		const { cards } = await allCards(campaign.id)
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

	it('summarises the review funnel after a bulk approve', async () => {
		const campaignId = await create('summary', 'Summary')
		const bulk = await call(app, `/api/campaigns/${campaignId}/approve-eligible`, { method: 'POST', cookie: lead })
		await expect(bulk.json()).resolves.toEqual({ approved: 39 })
		const { summary, activity } = await detailOf(campaignId)
		expect(summary).toMatchObject({
			total: 50,
			eligible: 39,
			approved: 39,
			toReview: 0,
			ready: 39,
			sent: 0,
			delivered: 0,
			returned: 0,
			needsAttention: 0,
		})
		expect(activity).toBeUndefined()
	})

	it('groups the activity: a bulk approve is one group of N, a single approval is its own', async () => {
		const { campaigns } = (await (await call(app, '/api/campaigns', { cookie: rep })).json()) as {
			campaigns: { id: number; name: string }[]
		}
		const top = campaigns.find((row) => row.name === 'Top 50')!.id
		await call(app, `/api/campaigns/${top}/approve-eligible`, { method: 'POST', cookie: lead })

		const activity = await activityOf(top)
		expect(activity).toMatchObject({
			pageSize: 20,
			nextCursor: null,
			actions: ['campaign.created', 'campaign.lines_written', 'card.approved', 'card.line_written'],
		})
		// The sheet names cards by rank and company, so the campaign's cards come with it, in rank order.
		expect(activity.cards.map((card) => card.rank)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1))
		expect(activity.cards.every((card) => card.companyName)).toBe(true)
		expect(activity.groups.map((group) => [group.action, group.count])).toEqual([
			['card.approved', 38],
			['card.approved', 1],
			['campaign.lines_written', 1],
			// The job's lines, one row per card, are one group: worker events join by action and actor.
			['card.line_written', 39],
			['campaign.created', 1],
		])
		const [bulk, single] = activity.groups as [Group, Group, Group, Group]
		expect(bulk.cardIds).toHaveLength(38)
		expect(bulk.id).toBe(String(bulk.events[0]!.id))
		expect(bulk.events.every((event) => event.link === `/campaigns/${top}`)).toBe(true)

		const created = await activityOf(top, '?action=campaign.created')
		expect(created).toMatchObject({ total: 1, actions: activity.actions })
		expect(created.groups[0]!.events[0]!.link).toBe(`/campaigns/${top}`)
		// The card's own history: its line was written, then it was approved.
		expect(await activityOf(top, `?card=${single.cardIds[0]}`)).toMatchObject({ total: 2 })
		const cardOnly = await activityOf(top, `?card=${single.cardIds[0]}&action=campaign.created`)
		expect(cardOnly.total).toBe(0)
		// A card of another campaign matches nothing.
		const foreign = (await allCards(campaigns.find((row) => row.name === 'Summary')!.id)).cards[0]!.id
		expect(await activityOf(top, `?card=${foreign}`)).toMatchObject({ total: 0, groups: [] })
		expect(await activityOf(top, '?to=2000-01-01T00:00:00Z')).toMatchObject({ total: 0 })
		expect(await activityOf(top, '?from=2000-01-01T00:00:00Z')).toMatchObject({ total: 5 })
		expect(await activityOf(top, '?from=2999-01-01T00:00:00Z')).toMatchObject({ total: 0 })
	})

	it('pages the activity 20 groups at a time and rejects a bad cursor', async () => {
		const campaignId = await create('paging', 'Paging')
		for (const id of (await draftIds(campaignId)).slice(0, 22)) {
			await call(app, `/api/cards/${id}/approve`, { method: 'POST', cookie: lead })
		}
		const first = await activityOf(campaignId)
		expect(first).toMatchObject({ total: 25, pageSize: 20, nextCursor: '20' })
		expect(first.groups).toHaveLength(20)
		const second = await activityOf(campaignId, '?cursor=20')
		expect(second).toMatchObject({ total: 25, nextCursor: null })
		expect(second.groups).toHaveLength(5)
		expect(new Set([...first.groups, ...second.groups].map((group) => group.id)).size).toBe(25)
		expect(await activityOf(campaignId, '?action=card.approved')).toMatchObject({ total: 22, nextCursor: '20' })

		for (const cursor of ['abc', '-1', '1.5', '', '99999999999'])
			expect((await call(app, `/api/campaigns/${campaignId}/activity?cursor=${cursor}`, { cookie: rep })).status).toBe(
				400,
			)
		expect((await call(app, `/api/campaigns/${campaignId}/activity?from=yesterday`, { cookie: rep })).status).toBe(400)
		expect((await call(app, '/api/campaigns/999999/activity', { cookie: rep })).status).toBe(404)
		expect((await call(app, `/api/campaigns/${campaignId}/activity`)).status).toBe(401)
	})

	it('approves and rejects a chosen set of cards', async () => {
		const campaignId = await create('chosen', 'Chosen')
		const [one, two, three, four, five] = await draftIds(campaignId)
		const post = (action: string, payload: unknown, cookie = lead) =>
			call(app, `/api/campaigns/${campaignId}/${action}`, { method: 'POST', cookie, body: payload })

		const denied = await post('approve', { cardIds: [one] }, rep)
		expect(denied.status).toBe(403)
		await expect(denied.json()).resolves.toMatchObject({ error: expect.stringMatching(/Only a sales lead/) as string })
		for (const payload of [{}, { cardIds: [] }, { cardIds: [0] }, { cardIds: ['1'] }, { cardIds: Array(501).fill(1) }])
			expect((await post('approve', payload)).status).toBe(400)

		const other = (await draftIds(await create('chosen-other', 'Other')))[0]!
		const approved = await post('approve', { cardIds: [one, two, other] })
		await expect(approved.json()).resolves.toEqual({ approved: 2 })

		expect((await post('reject', { cardIds: [three], reason: ' ' }, rep)).status).toBe(400)
		expect((await post('reject', { cardIds: [three] }, rep)).status).toBe(400)
		const rejected = await post('reject', { cardIds: [one, three, four, other], reason: 'Wrong people' }, rep)
		await expect(rejected.json()).resolves.toEqual({ rejected: 2 })
		await expect((await post('reject', { cardIds: [five], reason: 'Not now' }, rep)).json()).resolves.toEqual({
			rejected: 1,
		})

		const { cards } = await allCards(campaignId)
		expect(
			Object.fromEntries(
				cards.filter((card) => [one, two, three, four, five].includes(card.id)).map((card) => [card.id, card.status]),
			),
		).toEqual({
			[one!]: 'approved',
			[two!]: 'approved',
			[three!]: 'rejected',
			[four!]: 'rejected',
			[five!]: 'rejected',
		})
		const { groups } = await activityOf(campaignId)
		expect(groups.map((group) => [group.action, group.count]).sort()).toEqual(
			[
				['card.approved', 2],
				['card.rejected', 2],
				['card.rejected', 1],
				['campaign.created', 1],
				['campaign.lines_written', 1],
				['card.line_written', 39],
			].sort(),
		)
	})
	it('answers the campaign page with the campaign, templates and summary, and no cards', async () => {
		const campaignId = await create('no-cards', 'No cards')
		const detail = await detailOf(campaignId)
		expect(Object.keys(detail).sort()).toEqual(['campaign', 'linesJob', 'summary', 'templates'])
		expect(detail.templates).toHaveLength(2)
		expect((await call(app, '/api/campaigns/999999', { cookie: rep })).status).toBe(404)
	})

	// What the page used to count from the cards it held, kept here as the reference for the SQL summary.
	const summaryOf = (rows: CardRow[]) => {
		const count = (test: (card: CardRow) => boolean) => rows.filter(test).length
		const tally = (keys: (string | null)[]) =>
			keys.reduce<Record<string, number>>((all, key) => (key ? { ...all, [key]: (all[key] ?? 0) + 1 } : all), {})
		return {
			total: rows.length,
			eligible: count((card) => card.eligibility === 'eligible'),
			byStatus: tally(rows.map((card) => card.status)),
			blocked: tally(rows.map((card) => (card.eligibility === 'blocked' ? card.blockReason : null))),
			llmRejected: count((card) => card.llmStatus === 'rejected'),
			blockedAtSend: count((card) => card.status === 'blocked_at_send'),
			approved: count((card) => card.approvedAt !== null),
			toReview: count((card) => card.status === 'draft' && card.eligibility === 'eligible'),
			linesPending: 0,
			linesFailed: false,
			ready: count((card) => card.status === 'approved'),
			sent: count((card) => card.submittedAt !== null),
			delivered: count((card) => card.status === 'delivered'),
			returned: count((card) => card.status === 'returned'),
			needsAttention: count((card) => ['failed', 'unconfirmed'].includes(card.status)),
			variants: { A: count((card) => card.variant === 'A'), B: count((card) => card.variant === 'B') },
		}
	}

	describe('cards of a campaign', () => {
		let big: number

		beforeAll(async () => {
			const response = await call(app, '/api/campaigns', {
				method: 'POST',
				cookie: rep,
				body: { ...body, name: 'Three pages', topN: 120 },
				headers: { 'Idempotency-Key': 'three-pages' },
			})
			big = ((await response.json()) as { campaign: { id: number } }).campaign.id
			await runJobs()
			const [first, second, third, fourth] = await draftIds(big)
			await call(app, `/api/campaigns/${big}/approve`, {
				method: 'POST',
				cookie: lead,
				body: { cardIds: [first, second] },
			})
			await call(app, `/api/campaigns/${big}/reject`, {
				method: 'POST',
				cookie: rep,
				body: { cardIds: [third], reason: 'Not now' },
			})
			// Attempts belong to the card they were made for: two for one card, one for another, none for the rest.
			await t.db.insert(submissionAttempts).values([
				{ cardId: fourth!, n: 2, outcome: 'ok', httpStatus: 200, delayMs: null, error: null, at: now },
				{ cardId: fourth!, n: 1, outcome: 'timeout', httpStatus: null, delayMs: 120, error: 'timeout', at: now },
				{ cardId: first!, n: 1, outcome: 'ok', httpStatus: 200, delayMs: null, error: null, at: now },
			])
		})

		it('pages by rank, 50 at a time, without repeats, and ends with no cursor', async () => {
			const { pages, cards: all } = await allCards(big)
			expect(pages.map((page) => page.cards.length)).toEqual([50, 50, 20])
			expect(pages[0]).toMatchObject({ total: 120, pageSize: 50, nextCursor: expect.any(String) as string })
			expect(pages[2]!.nextCursor).toBeNull()
			expect(all.map((card) => card.rank)).toEqual([...all.map((card) => card.rank)].sort((a, b) => a - b))
			expect(new Set(all.map((card) => card.id)).size).toBe(120)
			const stored = await t.db.select({ id: cards.id }).from(cards).where(eq(cards.campaignId, big))
			expect(all.map((card) => card.id).sort((a, b) => a - b)).toEqual(
				stored.map((card) => card.id).sort((a, b) => a - b),
			)
			expect(all.every((card) => typeof card.companyName === 'string')).toBe(true)
		})

		it('has the summary a count of its cards gives', async () => {
			expect((await detailOf(big)).summary).toEqual(summaryOf((await allCards(big)).cards))
			expect((await detailOf(big)).summary).toMatchObject({ ready: 2, toReview: expect.any(Number) as number })
		})

		it('gives each card its own attempts, in order, and only those', async () => {
			const { cards: all } = await allCards(big)
			const withAttempts = all.filter((card) => card.attempts.length > 0)
			expect(withAttempts.map((card) => card.attempts.map((attempt) => attempt.n)).sort()).toEqual([[1], [1, 2]])
			for (const card of withAttempts) expect(card.attempts.every((attempt) => attempt.cardId === card.id)).toBe(true)
		})

		it('filters by view, template and company name, and counts what each choice would show', async () => {
			const { cards: all } = await allCards(big)
			const views: Record<string, (card: CardRow) => boolean> = {
				all: () => true,
				review: (card) => card.status === 'draft',
				approved: (card) => card.approvedAt !== null,
				sent: (card) => card.submittedAt !== null,
				delivered: (card) => card.status === 'delivered',
				attention: (card) => ['failed', 'unconfirmed'].includes(card.status),
				blocked: (card) => ['blocked', 'blocked_at_send'].includes(card.status),
				rejected: (card) => card.status === 'rejected',
				'ai-rejected': (card) => card.llmStatus === 'rejected',
			}
			const first = await cardsPage(big)
			for (const [view, test] of Object.entries(views))
				expect(first.counts.views[view], view).toBe(all.filter(test).length)
			expect(first.counts.variants).toEqual({
				A: all.filter((card) => card.variant === 'A').length,
				B: all.filter((card) => card.variant === 'B').length,
			})

			const review = await allCards(big, '?show=review')
			expect(review.cards.map((card) => card.id)).toEqual(all.filter(views.review!).map((card) => card.id))
			expect(review.pages[0]!.total).toBe(review.cards.length)

			// The variant filter changes the view counts; the view changes the variant counts.
			const variantA = await cardsPage(big, '?template=A&show=review')
			expect(variantA.cards.every((card) => card.variant === 'A' && card.status === 'draft')).toBe(true)
			expect(variantA.counts.views.review).toBe(
				all.filter((card) => card.variant === 'A' && card.status === 'draft').length,
			)
			expect(variantA.counts.views.all).toBe(all.filter((card) => card.variant === 'A').length)
			expect(variantA.counts.variants).toEqual({
				A: all.filter((card) => card.variant === 'A' && card.status === 'draft').length,
				B: all.filter((card) => card.variant === 'B' && card.status === 'draft').length,
			})

			const needle = all[7]!.companyName!.slice(1, 6).toUpperCase()
			const matching = all.filter((card) => card.companyName!.toLowerCase().includes(needle.toLowerCase()))
			const searched = await allCards(big, `?q=${encodeURIComponent(`  ${needle} `)}`)
			expect(searched.cards.map((card) => card.id)).toEqual(matching.map((card) => card.id))
			expect(searched.pages[0]!.counts.views.all).toBe(matching.length)
			expect((await cardsPage(big, '?q=%25')).total).toBe(0)
			expect((await cardsPage(big, '?q=no%20company%20is%20called%20this')).cards).toEqual([])
		})

		it('says which page holds a card, with the cursors that lead there', async () => {
			const { cards: all } = await allCards(big)
			const get = async (cardId: number) =>
				(await (await call(app, `/api/campaigns/${big}/cards/${cardId}/cursors`, { cookie: rep })).json()) as {
					cursors: string[]
				}
			expect((await get(all[0]!.id)).cursors).toEqual([])
			expect((await get(all[49]!.id)).cursors).toEqual([])
			const third = (await get(all[100]!.id)).cursors
			expect(third).toHaveLength(2)
			const page = await cardsPage(big, `?cursor=${third[1]}`)
			expect(page.cards.map((card) => card.id)).toContain(all[100]!.id)
			const [other] = await draftIds(await create('foreign-card', 'Foreign'))
			expect((await call(app, `/api/campaigns/${big}/cards/${other}/cursors`, { cookie: rep })).status).toBe(404)
		})

		it('refuses a bad cursor, view or template, an unknown campaign, and an unknown user', async () => {
			for (const query of [
				'?cursor=nonsense',
				'?cursor=' + Buffer.from('["x"]').toString('base64url'),
				'?show=everything',
				'?template=C',
				`?q=${'x'.repeat(201)}`,
			])
				expect((await call(app, `/api/campaigns/${big}/cards${query}`, { cookie: rep })).status, query).toBe(400)
			expect((await call(app, '/api/campaigns/999999/cards', { cookie: rep })).status).toBe(404)
			expect((await call(app, `/api/campaigns/${big}/cards`)).status).toBe(401)
		})
	})

	interface Listed {
		total: number
		pageSize: number
		nextCursor: string | null
		campaigns: { id: number; name: string; summary: Record<string, unknown> }[]
	}
	const listOf = async (query = '') =>
		(await (await call(app, `/api/campaigns${query}`, { cookie: rep })).json()) as Listed

	it('lists each campaign with the same summary as its detail page', async () => {
		const { campaigns: listed, total } = await listOf()
		expect(listed).toHaveLength(total)
		expect(total).toBeGreaterThan(5)
		for (const row of listed) expect(row.summary, row.name).toEqual((await detailOf(row.id)).summary)
		// Seeded history and the approved, rejected and blocked cards above make the funnels differ.
		expect(new Set(listed.map((row) => JSON.stringify(row.summary))).size).toBeGreaterThan(3)
	})

	it('flags a campaign whose "write lines" job failed, in the list and on its page', async () => {
		const campaignId = await create('lines-failed', 'Lines failed')
		const [card] = await t.db
			.select({ id: cards.id })
			.from(cards)
			.where(and(eq(cards.campaignId, campaignId), eq(cards.eligibility, 'eligible')))
			.limit(1)
		// What a job that stopped halfway leaves: a card without its line, and the job failed.
		await t.db.update(cards).set({ personalLine: null, lineSource: null }).where(eq(cards.id, card!.id))
		await t.db
			.update(jobs)
			.set({ status: 'failed', error: 'model down' })
			.where(and(eq(jobs.kind, JOB_KINDS.lines), eq(jobs.key, String(campaignId))))

		const listed = (await listOf()).campaigns.find((row) => row.id === campaignId)!
		expect(listed.summary).toMatchObject({ linesPending: 1, linesFailed: true })
		expect((await detailOf(campaignId)).summary).toEqual(listed.summary)
		// Other campaigns' jobs ended well.
		expect((await listOf()).campaigns.filter((row) => row.summary.linesFailed).map((row) => row.id)).toEqual([
			campaignId,
		])
	})

	it('pages the list 20 at a time, newest first, and rejects a bad cursor', async () => {
		const existing = await t.db.select().from(campaigns).limit(1)
		const { id: _id, ...base } = existing[0]!
		const before = (await listOf()).total
		// Three share each timestamp, so the id breaks the tie.
		await t.db.insert(campaigns).values(
			Array.from({ length: 23 }, (_, index) => ({
				...base,
				idempotencyKey: `page-${index}`,
				name: `Page ${index}`,
				createdAt: new Date(now.getTime() + (1 + Math.floor(index / 3)) * 86_400_000),
			})),
		)
		const expected = (await t.db.select().from(campaigns).orderBy(desc(campaigns.createdAt), desc(campaigns.id))).map(
			(row) => row.id,
		)

		const first = await listOf()
		expect(first).toMatchObject({ total: before + 23, pageSize: 20, nextCursor: expect.any(String) as string })
		expect(first.campaigns).toHaveLength(20)
		// A campaign without cards has an empty funnel.
		expect(first.campaigns[0]!.summary).toEqual({
			total: 0,
			eligible: 0,
			byStatus: {},
			blocked: {},
			llmRejected: 0,
			blockedAtSend: 0,
			variants: { A: 0, B: 0 },
			approved: 0,
			toReview: 0,
			linesPending: 0,
			linesFailed: false,
			ready: 0,
			sent: 0,
			delivered: 0,
			returned: 0,
			needsAttention: 0,
		})
		const second = await listOf(`?cursor=${first.nextCursor}`)
		expect(second).toMatchObject({ total: before + 23, nextCursor: null })
		expect(second.campaigns).toHaveLength(before + 3)
		expect([...first.campaigns, ...second.campaigns].map((row) => row.id)).toEqual(expected)

		for (const cursor of ['abc', 'e30', 'W10', 'x'.repeat(1001)])
			expect((await call(app, `/api/campaigns?cursor=${cursor}`, { cookie: rep })).status, cursor).toBe(400)
		expect((await call(app, '/api/campaigns')).status).toBe(401)
	})
	it('names each card by the company it belongs to now, after a merge took its company away', async () => {
		const campaignId = await create('merged-away', 'Merged away')
		const [x, y] = (await allCards(campaignId)).cards.filter((card) => card.blockReason !== 'no_contact')
		const merged = await call(app, `/api/companies/${x!.companyId}/merge`, {
			method: 'POST',
			cookie: rep,
			body: { otherCompanyId: y!.companyId, reason: 'Same group' },
		})
		const { companyId } = (await merged.json()) as { companyId: number }
		const after = (await allCards(campaignId)).cards.filter((card) => card.id === x!.id || card.id === y!.id)
		expect(after.map((card) => card.companyId)).toEqual([companyId, companyId])
		expect(after.every((card) => card.companyName !== null)).toBe(true)
		const named = await cardsPage(campaignId, `?q=${encodeURIComponent(after[1]!.companyName!)}`)
		expect(named.cards.map((card) => card.id)).toEqual(expect.arrayContaining([x!.id, y!.id]))
	})
})
