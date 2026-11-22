import { describe, expect, it } from 'vitest'
import { createDb } from './client.ts'

describe('createDb', () => {
	it('reports an idle connection dying (Postgres restart, seed:reset) instead of crashing the process', async () => {
		const seen: Error[] = []
		const db = createDb('postgres://localhost:1/none', (error) => seen.push(error))
		expect(() =>
			db.$client.emit('error', new Error('terminating connection due to administrator command')),
		).not.toThrow()
		expect(seen.map((error) => error.message)).toEqual(['terminating connection due to administrator command'])
		await db.$client.end()
	})
})
