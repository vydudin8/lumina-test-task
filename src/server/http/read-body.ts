import type { Context } from 'hono'
import type { z } from 'zod'

export async function readBody<T extends z.ZodType>(context: Context, schema: T): Promise<z.output<T> | null> {
	let body: unknown

	try {
		body = await context.req.json()
	} catch {
		return null
	}

	const result = schema.safeParse(body)
	return result.success ? result.data : null
}

export const invalidRequest = (context: Context) => context.json({ error: 'Invalid request' }, 400)
