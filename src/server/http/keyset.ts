import { sql, type SQLWrapper } from 'drizzle-orm'
import { z } from 'zod'

// Keyset ("seek") pagination. The cursor is the sort key of the last row on the page, so rows that someone
// adds or removes meanwhile never shift the next page (no repeats, no gaps), and a deep page costs what the first does.
// Sort keys must end with a unique column (id) to be a total order.

export const cursorParam = z.string().max(1000).optional()

export const encodeCursor = (key: unknown[]) => Buffer.from(JSON.stringify(key)).toString('base64url')

// The cursor comes from the client, so its values are validated before they reach SQL.
export function decodeCursor<T extends z.ZodType>(schema: T, cursor: string): z.output<T> | null {
	try {
		const result = schema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString()))
		return result.success ? result.data : null
	} catch {
		return null
	}
}

// `(a, b) < ($a, $b)` reads "after this row" for a descending sort, `>` for an ascending one.
export const afterKey = (columns: SQLWrapper[], key: unknown[], direction: 'asc' | 'desc') =>
	sql`(${sql.join(columns, sql`, `)}) ${direction === 'asc' ? sql`>` : sql`<`} (${sql.join(
		key.map((value) => sql`${value}`),
		sql`, `,
	)})`

// Query `limit + 1` rows: the extra one only says whether a next page exists.
export function toPage<T>(rows: T[], limit: number, keyOf: (row: T) => unknown[]) {
	const items = rows.slice(0, limit)
	return { items, nextCursor: rows.length > limit ? encodeCursor(keyOf(items.at(-1)!)) : null }
}

// Timestamps travel in the cursor as Postgres text: a JS Date would drop the microseconds and skip rows.
// Shaped like `timestamptz::text` (ISO DateStyle), so a forged cursor is a 400 here instead of a cast error in SQL.
export const timestampKey = z
	.string()
	.max(64)
	.regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2}){0,2})$/)
