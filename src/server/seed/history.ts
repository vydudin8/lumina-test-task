import { asc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { campaigns, cards, contacts, icpVersions, outcomeEvents, sourceCompanies, templates } from '../db/schema.ts'
import { loadMaster } from '../pipeline/resolve/store.ts'
import { icpVersion, scoreCompanies } from '../pipeline/score/store.ts'
import { personKey } from '../policy/person-key.ts'
import { readFixture, type History, type HistoryCard } from './fixtures.ts'
import { SEED_USERS } from './users.ts'

const DAY_MS = 86_400_000

// Past mailings, dated relative to the seed's now so the 90-day rule and attribution hold whenever it runs.
// Needs resolved companies and contacts, so it runs after the first ingestion. Idempotent on natural keys.
export async function seedHistory(db: Db, now: Date) {
	const history = readFixture<History>('history.json')
	const lead = SEED_USERS.find((user) => user.role === 'lead')!

	await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('seed-history'))`)
		const [firstIcp] = await tx.select().from(icpVersions).orderBy(asc(icpVersions.id)).limit(1)
		const icp = await icpVersion(tx, firstIcp!.id)
		const [templateA, templateB] = await tx.select().from(templates).orderBy(asc(templates.variant))
		const scored = scoreCompanies((await loadMaster(tx, now)).companies, icp)
		const scoreOf = (companyId: number) =>
			scored.ranked.find((row) => row.company.id === companyId)?.score ??
			scored.outOfProfile.find((row) => row.company.id === companyId)?.score

		const definitions: { key: string; name: string; daysAgo: number; cards: HistoryCard[] }[] = [
			{ key: 'seed:historical', ...history.historicalCampaign },
			{
				key: 'seed:pilot',
				...history.pilotCampaign,
				cards: history.pilotCampaign.cards.map((card) => ({ ...card, variant: 'A' as const })),
			},
		]

		for (const definition of definitions) {
			const submittedAt = new Date(now.getTime() - definition.daysAgo * DAY_MS)
			const [campaign] = await tx
				.insert(campaigns)
				.values({
					idempotencyKey: definition.key,
					requestHash: 'seed',
					name: definition.name,
					icpVersionId: icp.id,
					topN: definition.cards.length,
					templateAId: templateA!.id,
					templateBId: templateB!.id,
					status: 'sent',
					createdBy: lead.id,
					createdAt: new Date(submittedAt.getTime() - 2 * DAY_MS),
					launchedBy: lead.id,
					launchedByRole: 'lead',
					launchedAt: submittedAt,
				})
				.onConflictDoNothing({ target: campaigns.idempotencyKey })
				.returning()
			if (!campaign) continue

			const keys = definition.cards.map((card) => personKey(card.email))
			const people = await tx
				.select({ contact: contacts, companyId: sourceCompanies.companyId })
				.from(contacts)
				.innerJoin(sourceCompanies, eq(contacts.sourceCompanyId, sourceCompanies.id))
				.where(inArray(contacts.personKey, keys))
				.orderBy(asc(contacts.id))

			await tx
				.insert(cards)
				.values(
					definition.cards.map((card, index) => {
						const person = people.find((row) => row.contact.personKey === personKey(card.email))
						if (!person) throw new Error(`history.json names ${card.email}, who is not in the provider data`)
						const score = scoreOf(person.companyId!)
						const mailedAt = new Date(submittedAt.getTime() + 2 * DAY_MS)
						return {
							campaignId: campaign.id,
							companyId: person.companyId!,
							contactId: person.contact.id,
							personKey: person.contact.personKey,
							rank: index + 1,
							score: score?.score ?? '0',
							scoreDisplay: score?.display ?? 0,
							contributions: score?.contributions ?? [],
							recipient: {
								fullName: person.contact.fullName,
								firstName: person.contact.firstName,
								title: person.contact.title,
								function: null,
								seniority: person.contact.seniority,
								providers: [person.contact.provider],
								decidedBy: 'seeded history' as const,
								candidates: [],
							},
							address: null,
							eligibility: 'eligible' as const,
							variant: card.variant ?? 'A',
							personalLine:
								'Battery-electric machines from Lumina could help your team run quieter, diesel-free sites.',
							lineSource: 'template' as const,
							lineCites: [],
							lineEvidence: [],
							status: card.status,
							approvedBy: lead.id,
							approvedByRole: 'lead' as const,
							approvedAt: new Date(submittedAt.getTime() - DAY_MS),
							idempotencyKey: `${definition.key}:${index + 1}`,
							mailId: `mail_${definition.key.replace(':', '_')}_${index + 1}`,
							submittedAt,
							mailedAt,
							statusChangedAt: new Date(mailedAt.getTime() + 3 * DAY_MS),
							createdAt: campaign.createdAt,
						}
					}),
				)
				.onConflictDoNothing()
		}

		// Outcomes are dated from their card's mailed_at; the fixture row index is their natural key.
		const [historical] = await tx.select().from(campaigns).where(eq(campaigns.idempotencyKey, 'seed:historical'))
		const historicalCards = await tx.select().from(cards).where(eq(cards.campaignId, historical!.id))
		await tx
			.insert(outcomeEvents)
			.values(
				history.outcomes.map((outcome, index) => {
					const card = outcome.card
						? historicalCards.find((row) => row.personKey === personKey(outcome.card!))
						: undefined
					if (outcome.card && !card?.mailedAt)
						throw new Error(`history.json outcome ${index} points at an unknown card`)
					const occurredAt = card
						? new Date(card.mailedAt!.getTime() + outcome.dayOffset! * DAY_MS)
						: new Date(now.getTime() - outcome.daysAgo! * DAY_MS)
					return {
						kind: outcome.kind,
						domain: outcome.domain,
						personKey: outcome.personEmail ? personKey(outcome.personEmail) : null,
						occurredAt,
						source: outcome.source,
						idempotencyKey: `seed:outcome:${index}`,
						createdBy: 'system:seed',
						createdAt: now,
					}
				}),
			)
			.onConflictDoNothing()
	})
}
