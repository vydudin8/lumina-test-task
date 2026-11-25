// What a number field keeps from any keystroke or paste: digits, and one decimal point when allowed.
// No minus, no exponent, no leading zeros; a value above `max` becomes `max`.
export function cleanNumber(raw: string, { decimal = false, max }: { decimal?: boolean; max?: number } = {}) {
	let text = raw.replace(decimal ? /[^\d.]/g : /\D/g, '')
	if (decimal) {
		const [whole = '', ...fraction] = text.split('.')
		text = fraction.length ? `${whole || '0'}.${fraction.join('')}` : whole
	}
	text = text.replace(/^0+(?=\d)/, '')
	return max !== undefined && text !== '' && Number(text) > max ? String(max) : text
}

// Arrow-key step, as on a native number field: one up or down on the whole part, the fraction kept as typed
// (no float maths), never below zero, capped at `max`.
export function stepNumber(text: string, delta: 1 | -1, options: { decimal?: boolean; max?: number } = {}) {
	const [whole = '', fraction] = text.split('.')
	const next = Number(whole) + delta
	if (next < 0) return '0'
	return cleanNumber(fraction === undefined ? String(next) : `${next}.${fraction}`, options)
}
