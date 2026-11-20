import { beforeAll, describe, expect, it } from 'vitest'
import { runIngestion } from '../pipeline/ingest/index.ts'
import { seed } from '../seed/seed.ts'
import { call, createTestApp, loginAs, testDeps, type FetchApp } from '../test/app.ts'
import { useTestDb } from '../test/db.ts'

const now = new Date('2026-11-20T12:00:00Z')

interface ListRow {
	id: number
	name: string
	providers: string[]
	conflicts: string[]
	stale: string[]
}

describe('companies API', () => {
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

	const list = async (query = '') =>
		(await (await call(app, `/api/companies${query}`, { cookie })).json()) as {
			companies: ListRow[]
			summary: {
				companies: number
				sources: number
				conflicts: Record<string, number>
				stale: number
				possibleDuplicates: number
			}
		}

	it('lists 282 companies with a summary of conflicts, stale values and possible duplicates', async () => {
		const { companies, summary } = await list()
		expect(companies).toHaveLength(282)
		expect(summary).toMatchObject({ companies: 282, sources: 300, conflicts: { headcount: 7 } })
		expect(summary.possibleDuplicates).toBeGreaterThanOrEqual(2)
	})

	it('filters to companies with a headcount conflict', async () => {
		const { companies } = await list('?filter=conflict:headcount')
		expect(companies).toHaveLength(7)
		expect(
			companies.every((company) => company.conflicts.includes('headcount') && company.providers.length === 2),
		).toBe(true)
	})

	it('searches by name', async () => {
		const { companies } = await list()
		const { companies: found } = await list(`?q=${encodeURIComponent(companies[0]!.name.slice(0, 6))}`)
		expect(found.map((company) => company.id)).toContain(companies[0]!.id)
	})

	it('shows a company with where each value came from, its records, contacts and activity', async () => {
		const [conflicted] = (await list('?filter=conflict:headcount')).companies
		const response = await call(app, `/api/companies/${conflicted!.id}`, { cookie })
		const body = (await response.json()) as {
			company: {
				fields: { headcount: { provider: string; rawRecordId: number; conflict: boolean; candidates: unknown[] } }
				sources: { id: number; provider: string }[]
			}
			contacts: unknown[]
			activity: unknown[]
		}
		expect(body.company.fields.headcount).toMatchObject({ provider: 'factset', conflict: true })
		expect(body.company.fields.headcount.candidates).toHaveLength(2)
		expect(body.company.sources).toHaveLength(2)
		expect(body.contacts.length).toBeGreaterThan(0)
		expect(body.activity).toEqual([])
	})

	it('overrides a field only with a reason, and shows it in the activity', async () => {
		const [conflicted] = (await list('?filter=conflict:headcount')).companies
		const detail = (await (await call(app, `/api/companies/${conflicted!.id}`, { cookie })).json()) as {
			company: { sources: { id: number; provider: string }[] }
		}
		const apollo = detail.company.sources.find((source) => source.provider !== 'factset')!

		const missing = await call(app, `/api/companies/${conflicted!.id}/overrides`, {
			method: 'POST',
			cookie,
			body: { field: 'headcount', sourceId: apollo.id, reason: '' },
		})
		expect(missing.status).toBe(400)
		await expect(missing.json()).resolves.toMatchObject({ error: expect.stringMatching(/reason/) as string })

		const saved = await call(app, `/api/companies/${conflicted!.id}/overrides`, {
			method: 'POST',
			cookie,
			body: { field: 'headcount', sourceId: apollo.id, reason: 'Their website says so' },
		})
		expect(saved.status).toBe(200)
		const after = (await (await call(app, `/api/companies/${conflicted!.id}`, { cookie })).json()) as {
			company: { fields: { headcount: { sourceId: number } } }
			activity: { action: string; actorId: string; reason: string }[]
		}
		expect(after.company.fields.headcount.sourceId).toBe(apollo.id)
		expect(after.activity).toEqual([
			expect.objectContaining({ action: 'field.overridden', actorId: 'usr_rep_tom', reason: 'Their website says so' }),
		])
	})

	it('returns 404 for an unknown company', async () => {
		expect((await call(app, '/api/companies/999999', { cookie })).status).toBe(404)
	})
})
