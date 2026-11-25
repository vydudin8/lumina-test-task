import { describe, expect, it } from 'vitest'
import { COUNTRIES } from './countries.ts'
import { rankMatches } from './rank.ts'

const find = (term: string) =>
	rankMatches(COUNTRIES, term, (country) => [country.label, country.value]).map((c) => c.value)

describe('rankMatches', () => {
	it('puts names that start with the term before names that only contain it', () => {
		expect(find('ger')).toEqual(['DE', 'DZ', 'NE', 'NG'])
	})

	it('puts an exact code first and searches codes as well as names', () => {
		expect(find('gb')).toEqual(['GB'])
		expect(find('de').slice(0, 2)).toEqual(['DE', 'DK'])
	})

	it('ignores case and accents, and returns everything for an empty term', () => {
		expect(find('COTE')).toEqual(['CI'])
		expect(find('  ')).toHaveLength(249)
	})
})
