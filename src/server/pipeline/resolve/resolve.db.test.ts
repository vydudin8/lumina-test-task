import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Manifest } from '../../../../scripts/generate-fixtures.ts'
import { auditEvents, contacts, sourceCompanies } from '../../db/schema.ts'
import { readFixture } from '../../seed/fixtures.ts'
import { seed } from '../../seed/seed.ts'
import { testDeps } from '../../test/app.ts'
import { useTestDb } from '../../test/db.ts'
import { runIngestion } from '../ingest/index.ts'
import { loadMaster, mergeCompanies, overrideField, resolveAll, unmergeSource } from './store.ts'

const manifest = readFixture<Manifest>('manifest.json')
const now = new Date(`${manifest.anchor}T12:00:00Z`)
const tom = { id: 'usr_rep_tom', role: 'rep' } as const

describe('company master', () => {
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

	it('resolves 300 company records into 282 companies', async () => {
		const { companies } = await loadMaster(t.db, now)
		expect(companies).toHaveLength(282)
		expect(companies.reduce((sum, company) => sum + company.sources.length, 0)).toBe(300)
	})

	it('merges exactly the 18 seeded duplicates and nothing else', async () => {
		const { companies } = await loadMaster(t.db, now)
		expect(companies.filter((company) => company.sources.length > 1)).toHaveLength(18)
		for (const duplicate of manifest.duplicates) {
			const [a, b] = duplicate.records
			expect(await companyOf(a!), `${duplicate.name}: ${duplicate.tricks.join('; ')}`).toBe(await companyOf(b!))
		}
	})

	it('keeps near-duplicates apart and lists them as possible duplicates', async () => {
		const { possibleDuplicates } = await loadMaster(t.db, now)
		for (const { companies } of manifest.nearDuplicates) {
			const [a, b] = await Promise.all(companies.map((company) => companyOf(company.records[0]!)))
			expect(a).not.toBe(b)
			expect(possibleDuplicates).toContainEqual(
				expect.objectContaining({ companyIds: [Math.min(a!, b!), Math.max(a!, b!)] }),
			)
		}
	})

	it('flags exactly the 7 seeded headcount conflicts', async () => {
		const { companies } = await loadMaster(t.db, now)
		const conflicted = companies.filter((company) => company.fields.headcount.conflict).map((company) => company.id)
		const expected = await Promise.all(
			manifest.headcountConflicts.map((conflict) =>
				companyOf(manifest.duplicates.find((d) => d.companyKey === conflict.companyKey)!.records[0]!),
			),
		)
		expect(conflicted.sort()).toEqual(expected.sort())
	})

	it('flags exactly the 2 seeded address conflicts and keeps the higher-precedence street', async () => {
		const { companies } = await loadMaster(t.db, now)
		const conflicted = companies.filter((company) => company.fields.address.conflict)
		const expected = await Promise.all(
			manifest.addressConflicts.map((conflict) =>
				companyOf(manifest.duplicates.find((d) => d.companyKey === conflict.companyKey)!.records[0]!),
			),
		)
		expect(conflicted.map((company) => company.id).sort()).toEqual(expected.sort())
		for (const company of conflicted) {
			expect(company.fields.address.candidates).toHaveLength(2)
			expect(company.fields.address.value?.line1).not.toBe('2 Old Station Yard')
		}
	})

	it('marks FactSet financials older than 18 months as stale', async () => {
		const { companies } = await loadMaster(t.db, now)
		const staleIds = companies
			.filter((company) => company.fields.headcount.stale || company.fields.revenue.stale)
			.map((company) => company.id)
		const expected = await Promise.all(
			manifest.staleFactset.map((stale) => companyOf({ provider: 'factset', externalId: stale.fsymId })),
		)
		expect(staleIds.sort()).toEqual(expected.sort())
	})

	it('links all 600 contact records to their company', async () => {
		const rows = await t.db.select().from(contacts)
		expect(rows).toHaveLength(600)
		expect(rows.filter((contact) => contact.sourceCompanyId === null)).toEqual([])
		expect(new Set(rows.map((contact) => contact.personKey)).size).toBe(600 - manifest.counts.duplicateContacts)
	})

	it('gives the same result when resolution runs again', async () => {
		const before = await t.db.select().from(sourceCompanies).orderBy(sourceCompanies.id)
		await t.db.transaction((tx) => resolveAll(tx, now))
		expect(await t.db.select().from(sourceCompanies).orderBy(sourceCompanies.id)).toEqual(before)
	})

	it('overrides a conflicting field with a reason, audits it and keeps it after a re-pull', async () => {
		const conflict = manifest.headcountConflicts[0]!
		const duplicate = manifest.duplicates.find((d) => d.companyKey === conflict.companyKey)!
		const companyId = await companyOf(duplicate.records[0]!)
		const loser = conflict.values.find((value) => value.provider !== 'factset')!
		const [loserSource] = await t.db
			.select()
			.from(sourceCompanies)
			.where(and(eq(sourceCompanies.companyId, companyId), eq(sourceCompanies.provider, loser.provider)))

		await expect(
			overrideField(t.db, { companyId, field: 'headcount', sourceId: loserSource!.id, reason: ' ', actor: tom, now }),
		).rejects.toThrow(/reason/i)
		await overrideField(t.db, {
			companyId,
			field: 'headcount',
			sourceId: loserSource!.id,
			reason: 'Confirmed on the phone',
			actor: tom,
			now,
		})
		await runIngestion(testDeps(t.db, { clock: () => now }), loser.provider, 'system:test')

		const company = (await loadMaster(t.db, now)).companies.find((candidate) => candidate.id === companyId)!
		expect(company.fields.headcount).toMatchObject({
			value: loser.headcount,
			provider: loser.provider,
			override: { reason: 'Confirmed on the phone' },
		})
		const [event] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'field.overridden'))
		expect(event).toMatchObject({
			actorId: 'usr_rep_tom',
			decision: 'overridden',
			reason: 'Confirmed on the phone',
			entityId: String(companyId),
		})
		expect(event?.before).toMatchObject({ headcount: { provider: 'factset' } })
		expect(event?.after).toMatchObject({ headcount: { value: loser.headcount, provider: loser.provider } })
	})

	it('merges two companies by hand and splits them again; contacts follow their source record', async () => {
		const [gb, other] = manifest.nearDuplicates[0]!.companies
		const [gbId, otherId] = [await companyOf(gb!.records[0]!), await companyOf(other!.records[0]!)]

		await expect(
			mergeCompanies(t.db, { companyId: gbId, otherCompanyId: otherId, reason: '', actor: tom, now }),
		).rejects.toThrow(/reason/i)
		const merged = await mergeCompanies(t.db, {
			companyId: gbId,
			otherCompanyId: otherId,
			reason: 'Same firm, Irish branch',
			actor: tom,
			now,
		})
		expect(await companyOf(other!.records[0]!)).toBe(merged.companyId)
		await runIngestion(testDeps(t.db, { clock: () => now }), other!.records[0]!.provider, 'system:test')
		expect(await companyOf(other!.records[0]!)).toBe(await companyOf(gb!.records[0]!))

		const [otherSource] = await t.db
			.select()
			.from(sourceCompanies)
			.where(
				and(
					eq(sourceCompanies.provider, other!.records[0]!.provider),
					eq(sourceCompanies.externalId, other!.records[0]!.externalId),
				),
			)
		const split = await unmergeSource(t.db, {
			companyId: merged.companyId,
			sourceId: otherSource!.id,
			reason: 'Separate legal entity',
			actor: tom,
			now,
		})
		expect(await companyOf(other!.records[0]!)).not.toBe(await companyOf(gb!.records[0]!))

		const [contact] = await t.db.select().from(contacts).where(eq(contacts.sourceCompanyId, otherSource!.id))
		const master = await loadMaster(t.db, now)
		expect(master.companies.find((company) => company.id === split.companyId)?.contactIds).toContain(contact!.id)

		const actions = (await t.db.select().from(auditEvents)).map((event) => [event.action, event.reason])
		expect(actions).toContainEqual(['company.merged', 'Same firm, Irish branch'])
		expect(actions).toContainEqual(['company.unmerged', 'Separate legal entity'])
	})
})
