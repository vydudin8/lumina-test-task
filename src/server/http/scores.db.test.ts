import { beforeAll, describe, expect, it } from 'vitest'
import { runIngestion } from '../pipeline/ingest/index.ts'
import { DEFAULT_ICP_RULES } from '../seed/defaults.ts'
import { seed } from '../seed/seed.ts'
import { call, createTestApp, loginAs, testDeps, type FetchApp } from '../test/app.ts'
import { useTestDb } from '../test/db.ts'

const now = new Date('2026-11-20T12:00:00Z')

describe('ICP and scores API', () => {
	const t = useTestDb()
	let app: FetchApp
	let cookie: string

	beforeAll(async () => {
		await seed(t.db, { now })
		const deps = testDeps(t.db, { clock: () => now })
		for (const provider of ['apollo', 'factset', 'clay'] as const) await runIngestion(deps, provider, 'system:test')
		app = createTestApp(t.db, { clock: () => now })
		cookie = await loginAs(app, 'usr_rep_tom')
	})

	const json = async <T>(path: string, options: Parameters<typeof call>[2] = {}) =>
		(await (await call(app, path, { cookie, ...options })).json()) as T

	it('previews in/out counts for draft rules without saving them', async () => {
		const strict = DEFAULT_ICP_RULES.map((rule) => (rule.id === 'headcount' ? { ...rule, required: true } : rule))
		const base = await json<{ inProfile: number; outOfProfile: number }>('/api/icp/preview', {
			method: 'POST',
			body: { rules: DEFAULT_ICP_RULES },
		})
		const preview = await json<{
			inProfile: number
			outOfProfile: number
			reasons: { reason: string; count: number }[]
		}>('/api/icp/preview', {
			method: 'POST',
			body: { rules: strict },
		})
		expect(base.inProfile + base.outOfProfile).toBe(282)
		expect(preview.inProfile).toBeLessThan(base.inProfile)
		expect(preview.reasons.some((reason) => reason.reason.startsWith('Headcount'))).toBe(true)
		expect((await json<{ versions: unknown[] }>('/api/icp')).versions).toHaveLength(1)
	})

	it('rejects invalid rules with a 400', async () => {
		const response = await call(app, '/api/icp', { method: 'POST', cookie, body: { rules: [] } })
		expect(response.status).toBe(400)
	})

	it('saves a new version', async () => {
		const response = await call(app, '/api/icp', {
			method: 'POST',
			cookie,
			body: { rules: DEFAULT_ICP_RULES.slice(0, 4) },
		})
		expect(response.status).toBe(200)
		const { current, versions } = await json<{ current: { id: number; rules: unknown[] }; versions: unknown[] }>(
			'/api/icp',
		)
		expect(current.rules).toHaveLength(4)
		expect(versions).toHaveLength(2)
	})

	it('returns an older version for the editor and 404 for one that does not exist', async () => {
		const { versions } = await json<{ versions: { id: number }[] }>('/api/icp')
		const oldest = versions.at(-1)!.id
		const { current } = await json<{ current: { id: number; rules: unknown[] } }>(`/api/icp?version=${oldest}`)
		expect(current.id).toBe(oldest)
		expect(current.rules).toEqual(DEFAULT_ICP_RULES)
		expect((await call(app, '/api/icp?version=999', { cookie })).status).toBe(404)
	})

	interface ScoresPage {
		counts: { inProfile: number; outOfProfile: number }
		total: number
		nextCursor: string | null
		ranked: { rank: number; companyId: number; name: string | null; score: string; display: number }[]
		outOfProfile: { companyId: number; name: string | null; reasons: string[] }[]
	}
	const allPages = async (query: string) => {
		const pages: ScoresPage[] = []
		let cursor: string | null = null
		do {
			const page: ScoresPage = await json<ScoresPage>(`/api/scores?${query}${cursor ? `&cursor=${cursor}` : ''}`)
			pages.push(page)
			cursor = page.nextCursor
		} while (cursor)
		return pages
	}

	it('pages both tabs on the server, ranked by exact score then company id, with counts for both', async () => {
		const inPages = await allPages('version=1')
		const ranked = inPages.flatMap((page) => page.ranked)
		const { counts } = inPages[0]!
		expect(counts.inProfile + counts.outOfProfile).toBe(282)
		expect(ranked).toHaveLength(counts.inProfile)
		expect(inPages.length).toBe(Math.ceil(counts.inProfile / 20))
		expect(ranked.map((row) => row.rank)).toEqual(ranked.map((_, index) => index + 1))
		for (const [index, row] of ranked.slice(1).entries()) {
			const previous = ranked[index]!
			const order = Number(previous.score) - Number(row.score) || row.companyId - previous.companyId
			expect(order).toBeGreaterThan(0)
		}

		const out = (await allPages('version=1&tab=out')).flatMap((page) => page.outOfProfile)
		expect(out).toHaveLength(counts.outOfProfile)
		expect(out.map((row) => row.companyId)).toEqual(out.map((row) => row.companyId).sort((a, b) => a - b))
		expect(out.every((row) => row.reasons.length > 0)).toBe(true)
	})

	it('searches company names on the server, keeping each match at its real rank', async () => {
		const [first] = await allPages('version=1')
		const target = first!.ranked[7]!
		const needle = target.name!.slice(1, 7).toUpperCase()
		const found = await json<ScoresPage>(`/api/scores?version=1&q=${encodeURIComponent(needle)}`)
		expect(found.ranked).toContainEqual(target)
		expect(found.counts.inProfile).toBe(found.total)
		expect(found.ranked.every((row) => row.name!.toLowerCase().includes(needle.toLowerCase()))).toBe(true)
		const none = await json<ScoresPage>('/api/scores?version=1&q=zzzzqqq')
		expect(none.counts).toEqual({ inProfile: 0, outOfProfile: 0 })
		expect((await call(app, '/api/scores?cursor=garbage', { cookie })).status).toBe(400)
	})

	it('ranks companies for a chosen ICP version and explains one with a cited rationale', async () => {
		const { ranked } = await json<ScoresPage>('/api/scores?version=1')
		expect(ranked.every((row) => row.display >= 90)).toBe(true)

		const detail = await json<{
			rank: number
			score: { contributions: unknown[] }
			evidence: unknown[]
			rationale: unknown
		}>(`/api/scores/${ranked[3]!.companyId}?version=1`)
		expect(detail.rank).toBe(4)
		expect(detail.score.contributions).toHaveLength(5)
		expect(detail.rationale).toBeNull()

		const { rationale } = await json<{ rationale: { status: string; cites: string[] } }>(
			`/api/scores/${ranked[3]!.companyId}/rationale?version=1`,
			{ method: 'POST' },
		)
		expect(rationale.status).toBe('accepted')
		expect(
			(await json<{ rationale: unknown }>(`/api/scores/${ranked[3]!.companyId}?version=1`)).rationale,
		).toMatchObject({ status: 'accepted' })
	})
})
