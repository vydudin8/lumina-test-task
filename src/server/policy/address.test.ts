import { describe, expect, it } from 'vitest'
import { validateAddress } from './address.ts'

const valid = { line1: '19 Quarry Road', city: 'Cardiff', region: 'Cardiff', postcode: 'CF22 6AD', country: 'GB' }

describe('validateAddress', () => {
	it.each([
		valid,
		{ ...valid, postcode: 'cf226ad' },
		{ ...valid, country: 'IE', postcode: 'D02 X285' },
		{ ...valid, country: 'FR', postcode: '69003' },
		{ ...valid, country: 'NL', postcode: '3011 AB' },
	])('accepts %o', (address) => {
		expect(validateAddress(address)).toEqual({ ok: true })
	})

	it.each([
		[{ ...valid, line1: null }, 'missing_line1'],
		[{ ...valid, city: ' ' }, 'missing_city'],
		[{ ...valid, postcode: null }, 'missing_postcode'],
		[{ ...valid, postcode: 'CF22 6' }, 'invalid_postcode'],
		[{ ...valid, country: 'IE', postcode: 'CF22 6AD' }, 'invalid_postcode'],
		[{ ...valid, country: 'CH', postcode: '8001' }, 'unsupported_country'],
		[null, 'missing_address'],
	] as const)('rejects %o as %s', (address, reason) => {
		expect(validateAddress(address)).toEqual({ ok: false, reason })
	})
})
