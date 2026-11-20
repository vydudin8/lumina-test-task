import type { MAILING_COUNTRIES } from '#common/settings.ts'

const POSTCODE: Record<(typeof MAILING_COUNTRIES)[number], RegExp> = {
	GB: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i,
	IE: /^(?:[ACDEFHKNPRTV-Y]\d{2}|D6W)\s?[0-9ACDEFHKNPRTV-Y]{4}$/i,
	FR: /^\d{5}$/,
	DE: /^\d{5}$/,
	NL: /^\d{4}\s?[A-Z]{2}$/i,
}

export type AddressProblem =
	'missing_address' | 'unsupported_country' | 'missing_line1' | 'missing_city' | 'missing_postcode' | 'invalid_postcode'

interface Address {
	line1: string | null
	city: string | null
	postcode: string | null
	country: string | null
}

const blank = (value: string | null) => !value?.trim()

// Deterministic checks on the company office address the card will be printed with.
export function validateAddress(address: Address | null): { ok: true } | { ok: false; reason: AddressProblem } {
	if (!address) return { ok: false, reason: 'missing_address' }
	const pattern = POSTCODE[address.country as keyof typeof POSTCODE] as RegExp | undefined
	if (!pattern) return { ok: false, reason: 'unsupported_country' }
	if (blank(address.line1)) return { ok: false, reason: 'missing_line1' }
	if (blank(address.city)) return { ok: false, reason: 'missing_city' }
	if (blank(address.postcode)) return { ok: false, reason: 'missing_postcode' }
	if (!pattern.test(address.postcode!.trim().replace(/\s+/g, ' '))) return { ok: false, reason: 'invalid_postcode' }
	return { ok: true }
}
