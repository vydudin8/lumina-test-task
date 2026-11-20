import { readFileSync } from 'node:fs'

const FIXTURES_DIR = `${import.meta.dirname}/../../fixtures`

const read = <T>(path: string) => JSON.parse(readFileSync(`${FIXTURES_DIR}/${path}`, 'utf8')) as T

type Row = Record<string, unknown>

export function loadProviderFixtures() {
	return {
		apolloOrganizations: read<Row[]>('apollo/organizations.json'),
		apolloPeople: read<Row[]>('apollo/people.json'),
		factsetEntities: read<Row[]>('factset/entity-references.json'),
		factsetFundamentals: read<{ data: Row[] }>('factset/fundamentals.json').data,
		factsetPeople: read<Row[]>('factset/people.json'),
		clayTables: { companies: read<Row[]>('clay/companies.json'), people: read<Row[]>('clay/people.json') } as Record<
			string,
			Row[]
		>,
	}
}

export type ProviderFixtures = ReturnType<typeof loadProviderFixtures>
