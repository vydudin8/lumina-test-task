import { describe, expect, it } from 'vitest'
import { formatDecimal } from './format.ts'

describe('formatDecimal', () => {
	it('keeps at most two decimal places, rounding half up on the exact decimal', () => {
		expect(formatDecimal('72.222222222222222222')).toBe('72.22')
		// As a float 72.225 is 72.22499…; the string keeps it exact, so it rounds up.
		expect(formatDecimal('72.225')).toBe('72.23')
		expect(formatDecimal('100')).toBe('100')
		expect(formatDecimal('0.5')).toBe('0.5')
	})
})
