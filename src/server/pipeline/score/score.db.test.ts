import { icpRulesSchema } from '#common/icp.ts'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Manifest } from '../../../../scripts/generate-fixtures.ts'
import { auditEvents, scoreRationales, sourceCompanies } from '../../db/schema.ts'
import { createStubLlm } from '../../llm/stub.ts'
import type { Llm } from '../../llm/types.ts'
import { createLogger } from '../../log.ts'
import { readFixture } from '../../seed/fixtures.ts'
import { seed } from '../../seed/seed.ts'
import { testDeps } from '../../test/app.ts'
import { useTestDb } from '../../test/db.ts'
import { runIngestion } from '../ingest/index.ts'
import { currentIcp, getRationale, saveIcp, scoreMaster } from './store.ts'

const manifest = readFixture<Manifest>('manifest.json')
const now = new Date(`${manifest.anchor}T12:00:00Z`)
const maya = { id: 'usr_lead_maya', role: 'lead' } as const

function countingLlm(inner: Llm) {
	const llm = {
		...inner,
		calls: 0,
		generate: (request: Parameters<Llm['generate']>[0]) => (llm.calls++, inner.generate(request)),
	}
	return llm
}

describe('scoring', () => {
	const t = useTestDb()

	beforeAll(async () => {
		await seed(t.db, { now })
		const deps = testDeps(t.db, { clock: () => now })
		for (const provider of ['apollo', 'factset', 'clay'] as const) await runIngestion(deps, provider, 'system:test')
	})

	const companyOf = async (record: { provider: string; externalId: string }) => {
		const [row] = await t.db
			.select({ companyId: sourceCompanies.companyId })
			.from(sourceCompanies)
			.where(and(eq(sourceCompanies.provider, record.provider), eq(sourceCompanies.externalId, record.externalId)))
		return row!.companyId!
	}

	it('puts exactly the 50 seeded companies at 90 or more under the default ICP, with the expected scores', async () => {
		const { ranked } = await scoreMaster(t.db, await currentIcp(t.db), now)
		const top = ranked.slice(0, 50)
		const expected = new Map(
			await Promise.all(
				manifest.top50.companies.map(
					async (company) => [await companyOf(company.records[0]!), company.expectedScore] as const,
				),
			),
		)

		expect(top.map((row) => row.company.id).sort()).toEqual([...expected.keys()].sort())
		for (const row of top) expect(row.score.display).toBe(expected.get(row.company.id))
		expect(top.filter((row) => row.score.display === 100)).toHaveLength(22)
		expect(ranked[50]!.score.display).toBeLessThanOrEqual(manifest.top50.nextBestScore)
	})

	it('breaks ties by company id', async () => {
		const { ranked } = await scoreMaster(t.db, await currentIcp(t.db), now)
		const nineties = ranked.filter((row) => row.score.display === 90).map((row) => row.company.id)
		expect(nineties).toEqual([...nineties].sort((a, b) => a - b))
		expect(ranked.map((row) => row.rank)).toEqual(ranked.map((_, index) => index + 1))
	})

	it('saves a new ICP version with an audited diff and keeps the old one', async () => {
		const before = await currentIcp(t.db)
		const rules = icpRulesSchema
			.parse(before.rules)
			.map((rule) => (rule.id === 'signals' ? { ...rule, points: 15 } : rule))
		const saved = await saveIcp(t.db, { rules, actor: maya, now })

		expect(saved.id).toBe(before.id + 1)
		expect((await currentIcp(t.db)).id).toBe(saved.id)
		const [event] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'icp.saved'))
		expect(event).toMatchObject({
			actorId: 'usr_lead_maya',
			entityId: String(saved.id),
			result: { changed: ['signals'], added: [], removed: [] },
		})
	})

	it('generates a cited rationale once per company, ICP version and evidence', async () => {
		const icp = await currentIcp(t.db)
		const { ranked } = await scoreMaster(t.db, icp, now)
		const llm = countingLlm(createStubLlm({ hallucinateEvery: 0 }))
		const deps = { db: t.db, llm, log: createLogger({ level: 'silent' }), retry: {}, clock: () => now }

		const first = await getRationale(deps, ranked[0]!.company.id, icp.id)
		expect(first).toMatchObject({ status: 'accepted', model: 'stub-v1', promptVersion: 'rationale-v1' })
		expect(first.cites.length).toBeGreaterThan(0)
		expect(first.cites.every((cite) => first.evidence.some((item) => item.id === cite))).toBe(true)

		await getRationale(deps, ranked[0]!.company.id, icp.id)
		expect(llm.calls).toBe(1)
	})

	it('uses the template and audits the rejection when the model invents a number', async () => {
		const icp = await currentIcp(t.db)
		const { ranked } = await scoreMaster(t.db, icp, now)
		const deps = {
			db: t.db,
			llm: createStubLlm({ hallucinateEvery: 1 }),
			log: createLogger({ level: 'silent' }),
			retry: {},
			clock: () => now,
		}

		const rationale = await getRationale(deps, ranked[1]!.company.id, icp.id)
		expect(rationale).toMatchObject({ status: 'rejected', rejections: [{ code: 'uncited_number' }] })
		expect(rationale.text).toMatch(/scores \d+ out of 100/)
		const events = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'llm.output_rejected'))
		expect(events).toEqual([
			expect.objectContaining({
				actorId: 'system:llm',
				entityType: 'company',
				entityId: String(ranked[1]!.company.id),
			}),
		])
		expect(await t.db.select().from(scoreRationales)).toHaveLength(2)
	})
})
