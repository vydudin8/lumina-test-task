import { beforeAll, describe, expect, it } from 'vitest'
import { seedUsers } from '../seed/users.ts'
import { call, createTestApp, loginAs, type FetchApp } from '../test/app.ts'
import { useTestDb } from '../test/db.ts'

describe('providers API', () => {
	const t = useTestDb()
	let app: FetchApp
	let cookie: string

	beforeAll(async () => {
		await seedUsers(t.db)
		app = createTestApp(t.db)
		cookie = await loginAs(app, 'usr_rep_tom')
	})

	it('requires a picked user', async () => {
		expect((await call(app, '/api/providers')).status).toBe(401)
	})

	it('pulls a provider on request and reports the run on its panel', async () => {
		const pull = await call(app, '/api/providers/apollo/pull', { method: 'POST', cookie })
		expect(pull.status).toBe(200)

		const { providers } = (await (await call(app, '/api/providers', { cookie })).json()) as {
			providers: {
				provider: string
				lastRun: { status: string; creditsUsed: string; recordsRejected: number } | null
				records: { company: number; contact: number }
			}[]
		}
		const apollo = providers.find((panel) => panel.provider === 'apollo')
		expect(apollo).toMatchObject({
			lastRun: { status: 'succeeded_with_errors', creditsUsed: '432', recordsRejected: 1 },
			records: { company: 130, contact: 301 },
		})
		expect(providers.find((panel) => panel.provider === 'clay')?.lastRun).toBeNull()
	})

	it('rejects an unknown provider', async () => {
		expect((await call(app, '/api/providers/linkedin/pull', { method: 'POST', cookie })).status).toBe(404)
	})

	it('lists raw records with filters and opens one with its full payload', async () => {
		const list = (await (await call(app, '/api/raw-records?provider=apollo&kind=company', { cookie })).json()) as {
			total: number
			records: { id: number; label: string }[]
		}
		expect(list.total).toBe(130)
		expect(list.records).toHaveLength(50)

		const record = (await (await call(app, `/api/raw-records/${list.records[0]!.id}`, { cookie })).json()) as {
			record: { payload: { id: string; name: string } }
		}
		expect(record.record.payload.name).toBe(list.records[0]!.label)
	})

	it('lists runs with their rejected records', async () => {
		const { runs } = (await (await call(app, '/api/ingestion-runs', { cookie })).json()) as {
			runs: { provider: string; errors: { problem: string }[] }[]
		}
		expect(runs[0]).toMatchObject({ provider: 'apollo', errors: [{ problem: 'missing name' }] })
	})
})
