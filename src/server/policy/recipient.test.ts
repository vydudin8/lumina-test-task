import { describe, expect, it } from 'vitest'
import { chooseRecipient, targetFunction, type RecipientContact } from './recipient.ts'

let nextId = 1
const contact = (overrides: Partial<RecipientContact>): RecipientContact => ({
	id: nextId++,
	personKey: `p${nextId}@x.co.uk`,
	fullName: 'Someone',
	firstName: 'Some',
	title: 'Estimator',
	seniority: 'other',
	functions: [],
	provider: 'apollo',
	fetchedAt: '2026-11-20T10:00:00.000Z',
	...overrides,
})

describe('targetFunction', () => {
	it.each([
		[{ title: 'Operations Director', functions: ['operations', 'master_operations'] }, 'operations'],
		[{ title: 'Chief Operating Officer', functions: [] }, 'operations'],
		[{ title: 'Plant Manager', functions: ['engineering', 'master_engineering_technical'] }, 'fleet'],
		[{ title: 'Head of Fleet', functions: ['engineering'] }, 'fleet'],
		[{ title: 'Procurement Manager', functions: ['purchasing', 'master_operations'] }, 'procurement'],
		[{ title: 'ESG Manager', functions: ['corporate social responsibility'] }, 'sustainability'],
		[{ title: 'Managing Director', functions: ['finance'] }, null],
		[{ title: 'Site Manager', functions: [] }, null],
	])('%o -> %s', (input, expected) => {
		expect(targetFunction(input)).toBe(expected)
	})
})

describe('chooseRecipient', () => {
	it('prefers the target function over seniority', () => {
		const ceo = contact({ title: 'Chief Executive Officer', seniority: 'c_suite' })
		const ops = contact({ title: 'Operations Manager', seniority: 'manager', functions: ['operations'] })
		const result = chooseRecipient([ceo, ops])
		expect(result?.chosen.contactId).toBe(ops.id)
		expect(result?.decidedBy).toBe('function')
	})

	it('breaks a function tie on seniority', () => {
		const head = contact({ title: 'Head of Operations', seniority: 'head', functions: ['operations'] })
		const director = contact({ title: 'Operations Director', seniority: 'director', functions: ['operations'] })
		expect(chooseRecipient([head, director])).toMatchObject({
			chosen: { contactId: director.id },
			decidedBy: 'seniority',
		})
	})

	it('then on how many providers know the person, counting each person once', () => {
		const known = contact({
			personKey: 'a@x.co.uk',
			title: 'Operations Director',
			seniority: 'director',
			functions: ['operations'],
		})
		const alsoKnown = contact({
			personKey: 'a@x.co.uk',
			provider: 'clay',
			title: 'Operations Director',
			seniority: 'director',
			functions: ['operations'],
		})
		const single = contact({
			personKey: 'b@x.co.uk',
			title: 'Operations Director',
			seniority: 'director',
			functions: ['operations'],
		})
		const result = chooseRecipient([single, known, alsoKnown])
		expect(result).toMatchObject({
			chosen: { personKey: 'a@x.co.uk', providers: ['apollo', 'clay'] },
			decidedBy: 'corroboration',
		})
		expect(result?.candidates).toHaveLength(2)
	})

	it('then on the freshest record, then on the lowest contact id', () => {
		const older = contact({ title: 'Plant Manager', seniority: 'manager', fetchedAt: '2026-10-01T00:00:00.000Z' })
		const newer = contact({ title: 'Fleet Manager', seniority: 'manager', fetchedAt: '2026-11-01T00:00:00.000Z' })
		expect(chooseRecipient([older, newer])).toMatchObject({ chosen: { contactId: newer.id }, decidedBy: 'freshness' })
		const a = contact({ title: 'Plant Manager', seniority: 'manager' })
		const b = contact({ title: 'Fleet Manager', seniority: 'manager' })
		expect(chooseRecipient([b, a])).toMatchObject({ chosen: { contactId: a.id }, decidedBy: 'contact id' })
	})

	it('returns null when nobody is listed', () => {
		expect(chooseRecipient([])).toBeNull()
	})
})
