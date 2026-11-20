import { CREDIT_COSTS, type ProviderName } from '#common/settings.ts'
import Decimal from 'decimal.js'
import { createHash } from 'node:crypto'
import type { IngestionError } from '../../db/schema.ts'

export type RecordKind = 'company' | 'contact'
type Row = Record<string, unknown>

export interface ParsedRecord {
	kind: RecordKind
	externalId: string
	payload: Row
}

export interface Parsed {
	records: ParsedRecord[]
	errors: IngestionError[]
	// Every record the provider returned, valid or not: what credits are charged for.
	received: Record<RecordKind, number>
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical((value as Row)[key])]),
		)
	}
	return value
}

export const contentHash = (payload: unknown) =>
	createHash('sha256')
		.update(JSON.stringify(canonical(payload)))
		.digest('hex')

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const isEmail = (value: unknown): value is string =>
	typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
const textOrNull = (value: unknown) => (isText(value) ? value : null)

// Validates the few fields we key on; everything else is kept verbatim in the payload.
function collect(
	kind: RecordKind,
	rows: Row[],
	check: (row: Row) => { externalId: string | null; missing: string[] },
	parsed: Parsed,
) {
	for (const row of rows) {
		parsed.received[kind]++
		const { externalId, missing } = check(row)
		if (externalId && missing.length === 0) parsed.records.push({ kind, externalId, payload: row })
		else parsed.errors.push({ kind, externalId, problem: missing.join(', '), payload: row })
	}
}

const emptyParsed = (): Parsed => ({ records: [], errors: [], received: { company: 0, contact: 0 } })

export function parseApollo({ organizations, people }: { organizations: Row[]; people: Row[] }): Parsed {
	const parsed = emptyParsed()
	collect(
		'company',
		organizations,
		(org) => ({
			externalId: textOrNull(org.id),
			missing: [...(isText(org.id) ? [] : ['missing id']), ...(isText(org.name) ? [] : ['missing name'])],
		}),
		parsed,
	)
	collect(
		'contact',
		people,
		(person) => ({
			externalId: textOrNull(person.id),
			missing: [
				...(isText(person.id) ? [] : ['missing id']),
				...(isEmail(person.email) ? [] : ['invalid email']),
				...(isText(person.organization_id) ? [] : ['missing organization_id']),
			],
		}),
		parsed,
	)
	return parsed
}

// A FactSet company record is the entity reference plus its fundamentals rows, which arrive from a separate endpoint.
export function parseFactset({
	entities,
	fundamentals,
	people,
}: {
	entities: Row[]
	fundamentals: Row[]
	people: Row[]
}): Parsed {
	const parsed = emptyParsed()
	const byEntity = new Map<string, Row[]>()
	for (const row of fundamentals) {
		const fsymId = textOrNull(row.fsym_id)
		const problem = !fsymId
			? 'missing fsym_id'
			: !isText(row.metric)
				? 'missing metric'
				: typeof row.value !== 'number'
					? 'value is not a number'
					: null
		if (problem) parsed.errors.push({ kind: 'fundamental', externalId: fsymId, problem, payload: row })
		else byEntity.set(fsymId!, [...(byEntity.get(fsymId!) ?? []), row])
	}
	const order = (row: Row) => `${String(row.metric)}|${String(row.fiscal_end_date)}`
	collect(
		'company',
		entities,
		(entity) => ({
			externalId: textOrNull(entity.fsym_id),
			missing: [
				...(isText(entity.fsym_id) ? [] : ['missing fsym_id']),
				...(isText(entity.entity_proper_name) ? [] : ['missing entity_proper_name']),
			],
		}),
		parsed,
	)
	for (const record of parsed.records) {
		const rows = (byEntity.get(record.externalId) ?? []).sort((a, b) => order(a).localeCompare(order(b)))
		record.payload = { entity_reference: record.payload, fundamentals: rows }
	}
	collect(
		'contact',
		people,
		(person) => ({
			externalId: textOrNull(person.person_id),
			missing: [
				...(isText(person.person_id) ? [] : ['missing person_id']),
				...(isText(person.fsym_id) ? [] : ['missing fsym_id']),
				...(isEmail(person.email) ? [] : ['invalid email']),
			],
		}),
		parsed,
	)
	return parsed
}

// Clay rows have no stable id of their own; the domain and the work email are the natural keys.
export function parseClay({ companies, people }: { companies: Row[]; people: Row[] }): Parsed {
	const parsed = emptyParsed()
	const key = (value: unknown) => (isText(value) ? value.trim().toLowerCase() : null)
	collect(
		'company',
		companies,
		(row) => ({
			externalId: key(row.Domain),
			missing: [
				...(isText(row.Domain) ? [] : ['missing Domain']),
				...(isText(row['Company Name']) ? [] : ['missing Company Name']),
			],
		}),
		parsed,
	)
	collect(
		'contact',
		people,
		(row) => ({
			externalId: key(row['Work Email']),
			missing: [
				...(isEmail(row['Work Email']) ? [] : ['invalid Work Email']),
				...(isText(row['Company Domain']) ? [] : ['missing Company Domain']),
			],
		}),
		parsed,
	)
	return parsed
}

export function creditsFor(provider: ProviderName, received: Record<RecordKind, number>) {
	const costs = CREDIT_COSTS[provider]
	return new Decimal(costs.company).times(received.company).plus(new Decimal(costs.contact).times(received.contact))
}
