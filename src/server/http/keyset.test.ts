import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { decodeCursor, encodeCursor, timestampKey } from './keyset.ts'

describe('timestampKey', () => {
	it('accepts what Postgres prints for timestamptz::text', () => {
		for (const value of ['2026-11-20 12:00:00+00', '2026-11-20 12:00:00.123456+00', '2026-11-20 12:00:00.5+05:30'])
			expect(timestampKey.safeParse(value).success).toBe(true)
	})

	it('rejects anything else, so a forged cursor never reaches SQL', () => {
		const key = z.tuple([timestampKey, z.number().int()])
		expect(decodeCursor(key, encodeCursor(['x', 1]))).toBeNull()
		expect(decodeCursor(key, encodeCursor(["2026-11-20 12:00:00+00'; --", 1]))).toBeNull()
		expect(decodeCursor(key, encodeCursor(['2026-11-20 12:00:00+00', 1]))).toEqual(['2026-11-20 12:00:00+00', 1])
	})
})
