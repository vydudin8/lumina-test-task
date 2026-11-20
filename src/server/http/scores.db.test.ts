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

	it('ranks companies for a chosen ICP version and explains one with a cited rationale', async () => {
		const { ranked, outOfProfile } = await json<{
			ranked: { rank: number; companyId: number; display: number }[]
			outOfProfile: unknown[]
		}>('/api/scores?version=1')
		expect(ranked.slice(0, 50).every((row) => row.display >= 90)).toBe(true)
		expect(ranked.length + outOfProfile.length).toBe(282)

		const detail = await json<{ score: { contributions: unknown[] }; evidence: unknown[]; rationale: unknown }>(
			`/api/scores/${ranked[0]!.companyId}?version=1`,
		)
		expect(detail.score.contributions).toHaveLength(5)
		expect(detail.rationale).toBeNull()

		const { rationale } = await json<{ rationale: { status: string; cites: string[] } }>(
			`/api/scores/${ranked[0]!.companyId}/rationale?version=1`,
			{ method: 'POST' },
		)
		expect(rationale.status).toBe('accepted')
		expect(
			(await json<{ rationale: unknown }>(`/api/scores/${ranked[0]!.companyId}?version=1`)).rationale,
		).toMatchObject({ status: 'accepted' })
	})
})
