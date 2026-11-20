import { HttpError, parseRetryAfter, retry, type RetryOptions } from '../../lib/retry.ts'

type Row = Record<string, unknown>
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface PullOptions {
	baseUrl: string
	fetch: Fetch
	retry: RetryOptions
	now: () => Date
}

const REQUEST_TIMEOUT_MS = 10_000

// One HTTP call with a timeout, retried with jitter. Non-2xx responses become HttpError (429 carries Retry-After).
async function getJson<T>(url: string, init: RequestInit, options: PullOptions): Promise<T> {
	return retry(async () => {
		const response = await options.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
		if (!response.ok) {
			throw new HttpError(
				response.status,
				`${init.method ?? 'GET'} ${url} -> ${response.status}`,
				parseRetryAfter(response.headers.get('retry-after'), options.now()),
			)
		}
		return (await response.json()) as T
	}, options.retry)
}

async function apolloSearch(path: string, key: string, options: PullOptions) {
	const rows: Row[] = []
	for (let page = 1, totalPages = 1; page <= totalPages; page++) {
		const body = await getJson<Record<string, unknown> & { pagination: { total_pages: number } }>(
			`${options.baseUrl}/apollo/api/v1/${path}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ page, per_page: 100 }),
			},
			options,
		)
		rows.push(...(body[key] as Row[]))
		totalPages = body.pagination.total_pages
	}
	return rows
}

async function factsetList(path: string, options: PullOptions) {
	const rows: Row[] = []
	for (let offset = 0, total = 1; offset < total; offset += 100) {
		const body = await getJson<{ data: Row[]; meta: { pagination: { total: number } } }>(
			`${options.baseUrl}/factset/${path}?offset=${offset}&limit=100`,
			{},
			options,
		)
		rows.push(...body.data)
		total = body.meta.pagination.total
	}
	return rows
}

async function clayTable(table: string, options: PullOptions) {
	const rows: Row[] = []
	for (let cursor: string | null = ''; cursor !== null;) {
		const body: { rows: Row[]; next_cursor: string | null } = await getJson(
			`${options.baseUrl}/clay/tables/${table}/rows?limit=100&cursor=${cursor}`,
			{},
			options,
		)
		rows.push(...body.rows)
		cursor = body.next_cursor
	}
	return rows
}

export const pullApollo = async (options: PullOptions) => ({
	organizations: await apolloSearch('mixed_companies/search', 'organizations', options),
	people: await apolloSearch('mixed_people/search', 'people', options),
})

export const pullFactset = async (options: PullOptions) => ({
	entities: await factsetList('entity-references', options),
	fundamentals: await factsetList('fundamentals', options),
	people: await factsetList('company-people', options),
})

export const pullClay = async (options: PullOptions) => ({
	companies: await clayTable('companies', options),
	people: await clayTable('people', options),
})
