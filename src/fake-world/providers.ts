import { Hono } from 'hono'
import type { ProviderFixtures } from './fixtures.ts'

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))

// Read-only fakes shaped after the real list endpoints: Apollo search (page/per_page), FactSet (offset/limit), Clay (cursor).
export function providerRoutes(fixtures: ProviderFixtures, state: { rateLimited: Set<string> }) {
	const app = new Hono()

	const apolloSearch = (key: 'organizations' | 'people', rows: Record<string, unknown>[]) =>
		app.post(
			`/apollo/api/v1/${key === 'organizations' ? 'mixed_companies' : 'mixed_people'}/search`,
			async (context) => {
				const body = (await context.req.json().catch(() => ({}))) as { page?: number; per_page?: number }
				const perPage = clamp(Number(body.per_page ?? 25), 1, 100)
				const page = clamp(Number(body.page ?? 1), 1, 10_000)

				// One deliberate rate limit per process, so ingestion has to back off and retry.
				const limitKey = `apollo:${key}:${page}`
				if (key === 'people' && page === 2 && !state.rateLimited.has(limitKey)) {
					state.rateLimited.add(limitKey)
					return context.json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': '1' })
				}

				const totalPages = Math.ceil(rows.length / perPage)
				return context.json({
					[key]: rows.slice((page - 1) * perPage, page * perPage),
					pagination: { page, per_page: perPage, total_entries: rows.length, total_pages: totalPages },
				})
			},
		)
	apolloSearch('organizations', fixtures.apolloOrganizations)
	apolloSearch('people', fixtures.apolloPeople)

	const factsetList = (path: string, rows: Record<string, unknown>[]) =>
		app.get(`/factset/${path}`, (context) => {
			const offset = clamp(Number(context.req.query('offset') ?? 0), 0, rows.length)
			const limit = clamp(Number(context.req.query('limit') ?? 50), 1, 500)
			return context.json({
				data: rows.slice(offset, offset + limit),
				meta: { pagination: { total: rows.length, isEstimatedTotal: false } },
			})
		})
	factsetList('entity-references', fixtures.factsetEntities)
	factsetList('fundamentals', fixtures.factsetFundamentals)
	factsetList('company-people', fixtures.factsetPeople)

	app.get('/clay/tables/:table/rows', (context) => {
		const rows = fixtures.clayTables[context.req.param('table')]
		if (!rows) return context.json({ error: 'table not found' }, 404)
		const start = clamp(Number(context.req.query('cursor') || 0), 0, rows.length)
		const limit = clamp(Number(context.req.query('limit') ?? 50), 1, 200)
		const end = start + limit
		return context.json({ rows: rows.slice(start, end), next_cursor: end < rows.length ? String(end) : null })
	})

	return app
}
