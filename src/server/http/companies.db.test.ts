import Decimal from 'decimal.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { runIngestion } from '../pipeline/ingest/index.ts'
import { seed } from '../seed/seed.ts'
import { call, createTestApp, loginAs, testDeps, type FetchApp } from '../test/app.ts'
import { useTestDb } from '../test/db.ts'

const now = new Date('2026-11-20T12:00:00Z')

interface ListRow {
	id: number
	name: string
	country: string | null
	industry: string | null
	headcount: number | null
	revenueGbp: string | null
	providers: string[]
	conflicts: string[]
	stale: string[]
	overridden: string[]
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
			total: number
			nextCursor: string | null
			companies: ListRow[]
			facets: { countries: string[]; industries: string[] }
			summary: {
				companies: number
				sources: number
				conflicts: Record<string, number>
				stale: number
				possibleDuplicates: number
			}
		}

	it('lists 282 companies with a summary of conflicts, stale values and possible duplicates', async () => {
		const { companies, total, summary } = await list()
		expect(total).toBe(282)
		expect(companies).toHaveLength(20)
		expect(summary).toMatchObject({ companies: 282, sources: 300, conflicts: { headcount: 7, address: 2 } })
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

	it('sorts on the server with unknown values last and pages through every company exactly once', async () => {
		const seen: ListRow[] = []
		let cursor: string | null = null
		do {
			const page = await list(`?sort=headcount&dir=desc${cursor ? `&cursor=${cursor}` : ''}`)
			seen.push(...page.companies)
			cursor = page.nextCursor
		} while (cursor)
		expect(new Set(seen.map((row) => row.id)).size).toBe(282)
		const known = seen.filter((row) => row.headcount !== null).map((row) => row.headcount!)
		expect(known).toEqual([...known].sort((a, b) => b - a))
		expect(seen.slice(known.length).every((row) => row.headcount === null)).toBe(true)
	})

	const everyPage = async (query: string) => {
		const seen: ListRow[] = []
		let cursor: string | null = null
		do {
			const page = await list(`?${query}${cursor ? `&cursor=${cursor}` : ''}`)
			seen.push(...page.companies)
			cursor = page.nextCursor
		} while (cursor)
		return seen
	}

	it('pages every sort in both directions in the order the list always had', async () => {
		// The in-memory comparator the list used before sorting moved to SQL.
		const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
		const keyOf = {
			name: (row: ListRow) => row.name,
			country: (row: ListRow) => row.country,
			industry: (row: ListRow) => row.industry,
			headcount: (row: ListRow) => row.headcount,
			revenue: (row: ListRow) => row.revenueGbp,
			sources: (row: ListRow) => row.providers.length,
			flags: (row: ListRow) => row.conflicts.length + row.stale.length + row.overridden.length,
		}
		const all = await everyPage('')
		for (const [sort, key] of Object.entries(keyOf))
			for (const dir of ['asc', 'desc'] as const) {
				const expected = [...all].sort((a, b) => {
					const [x, y] = [key(a), key(b)]
					if (x === null || y === null) return x === y ? a.id - b.id : x === null ? 1 : -1
					const order =
						sort === 'revenue'
							? new Decimal(x).cmp(y)
							: typeof x === 'number'
								? x - (y as number)
								: collator.compare(x, String(y))
					return (dir === 'asc' ? order : -order) || a.id - b.id
				})
				const paged = await everyPage(`sort=${sort}&dir=${dir}`)
				expect(
					paged.map((row) => row.id),
					`${sort} ${dir}`,
				).toEqual(expected.map((row) => row.id))
			}
	})

	it('filters by several countries, sources and value ranges at once', async () => {
		const { companies, total, facets } = await list(
			'?country=GB,IE&source=apollo,factset&headcountMin=50&headcountMax=5000&revenueMin=10000000',
		)
		expect(facets.countries).toEqual(expect.arrayContaining(['GB', 'IE', 'DE']))
		expect(total).toBeGreaterThan(0)
		expect(total).toBeLessThan(282)
		for (const row of companies) {
			expect(['GB', 'IE']).toContain(row.country)
			expect(row.providers.some((provider) => provider === 'apollo' || provider === 'factset')).toBe(true)
			expect(row.headcount).toBeGreaterThanOrEqual(50)
			expect(row.headcount).toBeLessThanOrEqual(5000)
			expect(Number(row.revenueGbp)).toBeGreaterThanOrEqual(10_000_000)
		}
	})

	it('rejects a forged cursor, including one whose key does not fit the sort', async () => {
		const forged = Buffer.from(JSON.stringify(['abc', 1])).toString('base64url')
		expect((await call(app, `/api/companies?sort=revenue&cursor=${forged}`, { cookie })).status).toBe(400)
		expect((await call(app, '/api/companies?cursor=garbage', { cookie })).status).toBe(400)
		expect((await call(app, '/api/companies?headcountMin=-5', { cookie })).status).toBe(400)
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

	it('leads a merged-away company to the one it was merged into, and undoes the merge', async () => {
		const [x, y] = (await list('?filter=multi-source')).companies.slice(-2)
		const merged = await call(app, `/api/companies/${x!.id}/merge`, {
			method: 'POST',
			cookie,
			body: { otherCompanyId: y!.id, reason: 'Same group' },
		})
		const { companyId } = (await merged.json()) as { companyId: number }
		const gone = companyId === x!.id ? y!.id : x!.id
		const redirect = await call(app, `/api/companies/${gone}`, { cookie })
		// Temporary: an undone merge brings the number back, and a browser keeps a permanent redirect cached.
		expect(redirect.status).toBe(307)
		expect(redirect.headers.get('location')).toBe(`/api/companies/${companyId}`)

		const detail = (await (await call(app, `/api/companies/${companyId}`, { cookie })).json()) as {
			activity: { id: number; action: string }[]
			undoableMerges: number[]
		}
		const merge = detail.activity.find((event) => event.action === 'company.merged')!
		expect(detail.undoableMerges).toEqual([merge.id])
		const undo = (reason: string) =>
			call(app, `/api/companies/${companyId}/undo-merge`, {
				method: 'POST',
				cookie,
				body: { mergeEventId: merge.id, reason },
			})
		expect((await undo('')).status).toBe(400)
		const undone = await undo('Different groups')
		expect(await undone.json()).toEqual({ companyIds: [x!.id, y!.id] })
		expect((await call(app, `/api/companies/${gone}`, { cookie })).status).toBe(200)
		expect((await undo('Again')).status).toBe(409)
	})

	it('returns 404 for an unknown company', async () => {
		expect((await call(app, '/api/companies/999999', { cookie })).status).toBe(404)
	})
})
