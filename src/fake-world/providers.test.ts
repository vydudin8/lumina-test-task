import { describe, expect, it } from 'vitest'
import { createFakeWorld } from './app.ts'

const world = () => createFakeWorld()

async function post(app: ReturnType<typeof world>, path: string, body: unknown) {
	return app.fetch(
		new Request(`http://fake${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
	)
}

describe('fake Apollo', () => {
	it('pages through organizations like mixed_companies/search', async () => {
		const app = world()
		const first = (await (
			await post(app, '/apollo/api/v1/mixed_companies/search', { page: 1, per_page: 50 })
		).json()) as {
			organizations: unknown[]
			pagination: { page: number; per_page: number; total_entries: number; total_pages: number }
		}
		expect(first.organizations).toHaveLength(50)
		expect(first.pagination).toEqual({ page: 1, per_page: 50, total_entries: 131, total_pages: 3 })

		const last = (await (
			await post(app, '/apollo/api/v1/mixed_companies/search', { page: 3, per_page: 50 })
		).json()) as {
			organizations: unknown[]
		}
		expect(last.organizations).toHaveLength(31)
	})

	it('rate-limits the second people page once, with Retry-After', async () => {
		const app = world()
		const limited = await post(app, '/apollo/api/v1/mixed_people/search', { page: 2, per_page: 100 })
		expect(limited.status).toBe(429)
		expect(limited.headers.get('retry-after')).toBe('1')

		const retried = await post(app, '/apollo/api/v1/mixed_people/search', { page: 2, per_page: 100 })
		expect(retried.status).toBe(200)
		const body = (await retried.json()) as { people: unknown[] }
		expect(body.people).toHaveLength(100)
	})
})

describe('fake FactSet', () => {
	it('pages entity references with offset and limit', async () => {
		const response = await world().fetch(new Request('http://fake/factset/entity-references?offset=50&limit=50'))
		const body = (await response.json()) as { data: unknown[]; meta: { pagination: { total: number } } }
		expect(body.data).toHaveLength(30)
		expect(body.meta.pagination.total).toBe(80)
	})
})

describe('fake Clay', () => {
	it('pages table rows with a cursor until next_cursor is null', async () => {
		const app = world()
		let cursor: string | null = ''
		let rows = 0
		while (cursor !== null) {
			const response = await app.fetch(new Request(`http://fake/clay/tables/companies/rows?limit=40&cursor=${cursor}`))
			const page = (await response.json()) as { rows: unknown[]; next_cursor: string | null }
			rows += page.rows.length
			cursor = page.next_cursor
		}
		expect(rows).toBe(90)
	})

	it('returns 404 for an unknown table', async () => {
		expect((await world().fetch(new Request('http://fake/clay/tables/nope/rows'))).status).toBe(404)
	})
})
