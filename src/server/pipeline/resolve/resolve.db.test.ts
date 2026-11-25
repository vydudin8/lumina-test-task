import { icpRulesSchema } from '#common/icp.ts'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Manifest } from '../../../../scripts/generate-fixtures.ts'
import type { Executor } from '../../db/client.ts'
import {
	auditEvents,
	companies,
	companyDuplicates,
	companyProfiles,
	companyScores,
	contacts,
	fieldOverrides,
	sourceCompanies,
} from '../../db/schema.ts'
import { readFixture } from '../../seed/fixtures.ts'
import { seed } from '../../seed/seed.ts'
import { testDeps } from '../../test/app.ts'
import { useTestDb } from '../../test/db.ts'
import { runIngestion } from '../ingest/index.ts'
import { rankCompanies } from '../score/core.ts'
import { currentIcp, saveIcp, topRanked } from '../score/store.ts'
import {
	companyActivity,
	loadCompany,
	lockMaster,
	mergeCompanies,
	overrideField,
	rebuildAllProfiles,
	refreshProfiles,
	resolveAll,
	undoMerge,
	unmergeSource,
	type MasterCompany,
} from './store.ts'

const manifest = readFixture<Manifest>('manifest.json')
const now = new Date(`${manifest.anchor}T12:00:00Z`)
const tom = { id: 'usr_rep_tom', role: 'rep' } as const
const maya = { id: 'usr_lead_maya', role: 'lead' } as const

// Everything the master tables hold, in a fixed order, to compare stored state with a rebuild.
const storedState = async (executor: Executor) => ({
	profiles: await executor.select().from(companyProfiles).orderBy(companyProfiles.companyId),
	duplicates: await executor
		.select()
		.from(companyDuplicates)
		.orderBy(companyDuplicates.companyA, companyDuplicates.companyB),
	scores: await executor.select().from(companyScores).orderBy(companyScores.icpVersionId, companyScores.companyId),
})
// Row versions, to tell which rows a statement rewrote.
const rowVersions = async (executor: Executor, table: string) =>
	(await executor.execute<{ v: string }>(sql.raw(`SELECT xmin::text AS v FROM "${table}" ORDER BY ctid`))).rows

describe('company master', () => {
	const t = useTestDb()

	beforeAll(async () => {
		await seed(t.db, { now })
		const deps = testDeps(t.db, { clock: () => now })
		for (const provider of ['apollo', 'factset', 'clay'] as const) await runIngestion(deps, provider, 'system:test')
	})

	const sourceOf = async (record: { provider: string; externalId: string }) => {
		const [row] = await t.db
			.select()
			.from(sourceCompanies)
			.where(and(eq(sourceCompanies.provider, record.provider), eq(sourceCompanies.externalId, record.externalId)))
		return row!
	}
	const companyOf = async (record: { provider: string; externalId: string }) => (await sourceOf(record)).companyId!
	const loadMaster = async (executor: Executor = t.db, day = now) => {
		const ids = await executor
			.select({ id: companyProfiles.companyId })
			.from(companyProfiles)
			.orderBy(companyProfiles.companyId)
		const companies = (await Promise.all(ids.map((row) => loadCompany(executor, row.id, day)))) as MasterCompany[]
		const pairs = await executor.select().from(companyDuplicates)
		return {
			companies,
			possibleDuplicates: pairs.map((pair) => ({ companyIds: [pair.companyA, pair.companyB], reason: pair.reason })),
		}
	}

	it('resolves 300 company records into 282 companies', async () => {
		const { companies } = await loadMaster()
		expect(companies).toHaveLength(282)
		expect(companies.reduce((sum, company) => sum + company.sources.length, 0)).toBe(300)
	})

	it('merges exactly the 18 seeded duplicates and nothing else', async () => {
		const { companies } = await loadMaster()
		expect(companies.filter((company) => company.sources.length > 1)).toHaveLength(18)
		for (const duplicate of manifest.duplicates) {
			const [a, b] = duplicate.records
			expect(await companyOf(a!), `${duplicate.name}: ${duplicate.tricks.join('; ')}`).toBe(await companyOf(b!))
		}
	})

	it('keeps near-duplicates apart and lists them as possible duplicates', async () => {
		const { possibleDuplicates } = await loadMaster()
		for (const { companies } of manifest.nearDuplicates) {
			const [a, b] = await Promise.all(companies.map((company) => companyOf(company.records[0]!)))
			expect(a).not.toBe(b)
			expect(possibleDuplicates).toContainEqual(
				expect.objectContaining({ companyIds: [Math.min(a!, b!), Math.max(a!, b!)] }),
			)
		}
	})

	it('flags exactly the 7 seeded headcount conflicts', async () => {
		const { companies } = await loadMaster()
		const conflicted = companies.filter((company) => company.fields.headcount.conflict).map((company) => company.id)
		const expected = await Promise.all(
			manifest.headcountConflicts.map((conflict) =>
				companyOf(manifest.duplicates.find((d) => d.companyKey === conflict.companyKey)!.records[0]!),
			),
		)
		expect(conflicted.sort()).toEqual(expected.sort())
	})

	it('flags exactly the 2 seeded address conflicts and keeps the higher-precedence street', async () => {
		const { companies } = await loadMaster()
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
		const { companies } = await loadMaster()
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

	it('gives the same result when resolution runs again, without rewriting a single row', async () => {
		const before = await t.db.select().from(sourceCompanies).orderBy(sourceCompanies.id)
		const tables = ['source_companies', 'contacts', 'company_profiles', 'company_scores', 'companies']
		const versions = await Promise.all(tables.map((table) => rowVersions(t.db, table)))
		await t.db.transaction((tx) => resolveAll(tx, now))
		expect(await t.db.select().from(sourceCompanies).orderBy(sourceCompanies.id)).toEqual(before)
		expect(await Promise.all(tables.map((table) => rowVersions(t.db, table)))).toEqual(versions)
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

		const company = (await loadMaster()).companies.find((candidate) => candidate.id === companyId)!
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
		const master = await loadMaster()
		expect(master.companies.find((company) => company.id === split.companyId)?.contactIds).toContain(contact!.id)

		const actions = (await t.db.select().from(auditEvents)).map((event) => [event.action, event.reason])
		expect(actions).toContainEqual(['company.merged', 'Same firm, Irish branch'])
		expect(actions).toContainEqual(['company.unmerged', 'Separate legal entity'])
	})

	it('a split-off record gets a new company; the records left behind keep the company number', async () => {
		// Two records tie on keeping the number, and the older one used to win even when it was the one split off.
		const duplicate = manifest.duplicates.findLast((candidate) => candidate.records.length === 2)!
		const [older, newer] = (await Promise.all(duplicate.records.map(sourceOf))).sort((a, b) => a.id - b.id)
		const companyId = older!.companyId!
		expect(await companyOf(newer!)).toBe(companyId)

		const split = await unmergeSource(t.db, {
			companyId,
			sourceId: older!.id,
			reason: 'Different firm, same domain',
			actor: tom,
			now,
		})

		expect(split.companyId).not.toBe(companyId)
		expect(await companyOf(older!)).toBe(split.companyId)
		expect(await companyOf(newer!)).toBe(companyId)
	})
	it('stores no stale flag: each read marks what is stale on its own day', async () => {
		const [stale] = manifest.staleFactset
		const companyId = await companyOf({ provider: 'factset', externalId: stale!.fsymId })
		const [stored] = await t.db
			.select({ fields: companyProfiles.fields })
			.from(companyProfiles)
			.where(eq(companyProfiles.companyId, companyId))
		expect(stored!.fields.headcount.stale).toBe(false)
		expect((await loadCompany(t.db, companyId, now))!.fields.headcount.stale).toBe(true)
		const asOf = new Date(`${stored!.fields.headcount.asOf}T00:00:00Z`)
		expect((await loadCompany(t.db, companyId, asOf))!.fields.headcount.stale).toBe(false)
	})

	it('shows a committed override at once and never a rolled-back one', async () => {
		const before = await loadMaster()
		const company = before.companies.find(
			(candidate) => candidate.fields.headcount.candidates.length > 1 && !candidate.fields.headcount.override,
		)!
		const other = company.fields.headcount.candidates.find(
			(candidate) => candidate.sourceId !== company.fields.headcount.sourceId,
		)!
		const pick = {
			companyId: company.id,
			field: 'headcount' as const,
			chosenSourceId: other.sourceId,
			createdBy: tom.id,
			reason: 'Test',
			at: now,
		}
		const headcountOf = async (executor: Executor) => (await loadCompany(executor, company.id, now))!.fields.headcount

		await expect(
			t.db.transaction(async (tx) => {
				await lockMaster(tx)
				await tx.insert(fieldOverrides).values(pick)
				await refreshProfiles(tx, [company.id], now)
				expect((await headcountOf(tx)).sourceId).toBe(other.sourceId)
				throw new Error('rollback')
			}),
		).rejects.toThrow('rollback')
		expect((await loadMaster()).companies).toEqual(before.companies)
		expect((await headcountOf(t.db)).sourceId).not.toBe(other.sourceId)

		await overrideField(t.db, {
			companyId: company.id,
			field: 'headcount',
			sourceId: other.sourceId,
			reason: 'Confirmed on the phone',
			actor: tom,
			now,
		})
		expect((await headcountOf(t.db)).sourceId).toBe(other.sourceId)
	})

	it('merges, splits and overrides from the stored records, never reading the raw data again', async () => {
		const [gb, other] = manifest.nearDuplicates[1]!.companies
		const [gbId, otherId] = [await companyOf(gb!.records[0]!), await companyOf(other!.records[0]!)]
		const contactVersions = await rowVersions(t.db, 'contacts')
		await t.db.execute(sql`ALTER TABLE raw_records RENAME TO raw_records_hidden`)
		try {
			const merged = await mergeCompanies(t.db, {
				companyId: gbId,
				otherCompanyId: otherId,
				reason: 'Same group',
				actor: tom,
				now,
			})
			const company = (await loadCompany(t.db, merged.companyId, now))!
			const headcount = company.fields.headcount.candidates.at(-1)
			if (headcount)
				await overrideField(t.db, {
					companyId: company.id,
					field: 'headcount',
					sourceId: headcount.sourceId,
					reason: 'Checked',
					actor: tom,
					now,
				})
			await unmergeSource(t.db, {
				companyId: company.id,
				sourceId: company.sources.at(-1)!.id,
				reason: 'Not the same group',
				actor: tom,
				now,
			})
		} finally {
			await t.db.execute(sql`ALTER TABLE raw_records_hidden RENAME TO raw_records`)
		}
		expect(await rowVersions(t.db, 'contacts')).toEqual(contactVersions)
	})

	// Two-record companies no other test here touches, two per test below. Each test leaves the company count as it was.
	const spare = manifest.duplicates
		.slice(0, -1)
		.filter(
			(d) => ![...manifest.headcountConflicts, ...manifest.addressConflicts].some((c) => c.companyKey === d.companyKey),
		)
	const twoCompanies = async (offset: number) => {
		const [xs, ys] = await Promise.all(
			spare.slice(offset, offset + 2).map((d) => Promise.all(d.records.map((record) => sourceOf(record)))),
		)
		return { xs: xs!, ys: ys!, xId: xs![0]!.companyId!, yId: ys![0]!.companyId! }
	}
	const mergedIntoOf = async (companyId: number) =>
		(await t.db.select().from(companies).where(eq(companies.id, companyId)))[0]!.mergedInto
	const lastMerge = async (companyId: number) =>
		(
			await t.db
				.select()
				.from(auditEvents)
				.where(and(eq(auditEvents.action, 'company.merged'), eq(auditEvents.entityId, String(companyId))))
				.orderBy(desc(auditEvents.id))
				.limit(1)
		)[0]!

	it('merges two companies of two records each into one, and undoing it gives each its records and number back', async () => {
		const { xs, ys, xId, yId } = await twoCompanies(0)
		const companiesOf = async (records: typeof xs) => new Set(await Promise.all(records.map(companyOf)))

		const merged = await mergeCompanies(t.db, {
			companyId: xId,
			otherCompanyId: yId,
			reason: 'Same group',
			actor: tom,
			now,
		})
		expect(await companiesOf([...xs, ...ys])).toEqual(new Set([merged.companyId]))
		const gone = merged.companyId === xId ? yId : xId
		expect(await mergedIntoOf(gone)).toBe(merged.companyId)
		// A later pull keeps it whole: each record's domain is already in the company.
		for (const provider of new Set([...xs, ...ys].map((source) => source.provider)))
			await runIngestion(testDeps(t.db, { clock: () => now }), provider as 'apollo', 'system:test')
		expect(await companiesOf([...xs, ...ys])).toEqual(new Set([merged.companyId]))

		const event = await lastMerge(merged.companyId)
		const input = { companyId: merged.companyId, mergeEventId: event.id, reason: 'Different groups', actor: tom, now }
		await expect(undoMerge(t.db, { ...input, reason: ' ' })).rejects.toThrow(/reason/i)
		const undone = await undoMerge(t.db, input)
		expect(undone.companyIds).toEqual([xId, yId])
		expect(await companiesOf(xs)).toEqual(new Set([xId]))
		expect(await companiesOf(ys)).toEqual(new Set([yId]))
		expect(await mergedIntoOf(gone)).toBeNull()
		await expect(undoMerge(t.db, input)).rejects.toThrow(/cannot be undone/)
		const [undoEvent] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'company.merge_undone'))
		expect(undoEvent).toMatchObject({ reason: 'Different groups', after: { companies: [xId, yId] } })
	})

	it('shows each chosen value on the company that holds its record, through a merge and its undo', async () => {
		const { xs, ys, xId, yId } = await twoCompanies(2)
		// A second apart, as people choose: the latest choice wins.
		let second = 0
		const choose = (companyId: number, source: (typeof xs)[number], reason: string) =>
			overrideField(t.db, {
				companyId,
				field: 'name',
				sourceId: source.id,
				reason,
				actor: tom,
				now: new Date(now.getTime() + ++second * 1000),
			})
		const activityOf = async (companyId: number) => companyActivity(t.db, (await loadCompany(t.db, companyId, now))!)
		// Only this test's choices: an earlier one picked a value for one of these companies too.
		const [{ since }] = (await t.db
			.select({ since: sql<string>`coalesce(max(${auditEvents.id}), 0)` })
			.from(auditEvents)) as [{ since: string }]
		const choices = async (companyId: number) =>
			(await activityOf(companyId)).activity
				.filter((event) => event.action === 'field.overridden' && event.id > Number(since))
				.map((event) => event.reason)

		for (const [i, source] of [xs[0], xs[1], xs[0]].entries()) await choose(xId, source!, `x${i + 1}`)
		for (const i of [0, 1, 2, 3, 4]) await choose(yId, ys[i % 2]!, `y${i + 1}`)
		const merged = await mergeCompanies(t.db, {
			companyId: xId,
			otherCompanyId: yId,
			reason: 'Same group',
			actor: tom,
			now,
		})
		expect(await choices(merged.companyId)).toEqual(['y5', 'y4', 'y3', 'y2', 'y1', 'x3', 'x2', 'x1'])
		const event = await lastMerge(merged.companyId)
		expect((await activityOf(merged.companyId)).undoableMerges).toEqual([event.id])

		await choose(merged.companyId, xs[1]!, 'after, from x')
		await choose(merged.companyId, ys[0]!, 'after, from y')
		await undoMerge(t.db, { companyId: merged.companyId, mergeEventId: event.id, reason: 'Apart', actor: tom, now })

		expect(await choices(xId)).toEqual(['after, from x', 'x3', 'x2', 'x1'])
		expect(await choices(yId)).toEqual(['after, from y', 'y5', 'y4', 'y3', 'y2', 'y1'])
		for (const companyId of [xId, yId]) {
			const { activity, undoableMerges } = await activityOf(companyId)
			expect(activity.map((row) => row.action)).toEqual(
				expect.arrayContaining(['company.merged', 'company.merge_undone']),
			)
			expect(undoableMerges).toEqual([])
		}
		// The values follow the same rule: each company is back on its own latest choice.
		expect((await loadCompany(t.db, xId, now))!.fields.name.override?.reason).toBe('after, from x')
		expect((await loadCompany(t.db, yId, now))!.fields.name.override?.reason).toBe('after, from y')
	})

	it('splitting one record off a merged company keeps the rest of it together', async () => {
		const { xs, ys, xId, yId } = await twoCompanies(4)
		const merged = await mergeCompanies(t.db, {
			companyId: xId,
			otherCompanyId: yId,
			reason: 'Same group',
			actor: tom,
			now,
		})
		const split = await unmergeSource(t.db, {
			companyId: merged.companyId,
			sourceId: xs[0]!.id,
			reason: 'Wrong firm',
			actor: tom,
			now,
		})
		expect(await companyOf(xs[0]!)).toBe(split.companyId)
		expect(new Set(await Promise.all([xs[1]!, ...ys].map(companyOf)))).toEqual(new Set([merged.companyId]))
	})

	// The oracle: whatever sequence of pulls, overrides, merges and splits came before (every test above), the stored
	// profiles, possible duplicates and scores equal a rebuild from scratch, and the stored ranking is rankCompanies'.
	it('keeps stored profiles, duplicates and scores equal to a rebuild from scratch', async () => {
		const strict = icpRulesSchema
			.parse((await currentIcp(t.db)).rules)
			.map((rule) => (rule.id === 'headcount' ? { ...rule, required: true } : rule))
		const second = await saveIcp(t.db, { rules: strict, actor: maya, now })
		const [a, b] = manifest.nearDuplicates[0]!.companies
		const merged = await mergeCompanies(t.db, {
			companyId: await companyOf(a!.records[0]!),
			otherCompanyId: await companyOf(b!.records[0]!),
			reason: 'Same firm after all',
			actor: tom,
			now,
		})
		await runIngestion(testDeps(t.db, { clock: () => now }), 'clay', 'system:test')
		const company = (await loadCompany(t.db, merged.companyId, now))!
		await unmergeSource(t.db, {
			companyId: company.id,
			sourceId: company.sources[0]!.id,
			reason: 'Separate after all',
			actor: tom,
			now,
		})

		const stored = await storedState(t.db)
		let rebuilt: typeof stored | undefined
		await expect(
			t.db.transaction(async (tx) => {
				await rebuildAllProfiles(tx, now)
				rebuilt = await storedState(tx)
				throw new Error('rollback')
			}),
		).rejects.toThrow('rollback')
		// One duplicate was split for good above.
		expect(stored.profiles).toHaveLength(283)
		expect(new Set(stored.scores.map((score) => score.icpVersionId)).size).toBe(2)
		expect(stored).toEqual(rebuilt)

		for (const icp of [await currentIcp(t.db), { ...second, rules: strict }]) {
			const expected = rankCompanies(
				icp.rules,
				stored.profiles.map((profile) => ({ companyId: profile.companyId, facts: profile })),
			)
			const ranked = await topRanked(t.db, icp.id, 1000)
			expect(ranked.map((row) => [row.companyId, row.score])).toEqual(
				expected.inProfile.map((row) => [row.companyId, row.score]),
			)
			const out = await t.db
				.select({ companyId: companyScores.companyId })
				.from(companyScores)
				.where(and(eq(companyScores.icpVersionId, icp.id), eq(companyScores.inProfile, false)))
				.orderBy(asc(companyScores.companyId))
			expect(out.map((row) => row.companyId)).toEqual(expected.outOfProfile.map((row) => row.companyId))
		}
	})
})
