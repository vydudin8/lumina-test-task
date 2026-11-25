import { describe, expect, it } from 'vitest'
import { cleanNumber, stepNumber } from './number-input.ts'

describe('cleanNumber', () => {
	it('keeps digits only: no minus, exponent, spaces or separators', () => {
		expect(cleanNumber('-12')).toBe('12')
		expect(cleanNumber('1e5')).toBe('15')
		expect(cleanNumber('10,000 000')).toBe('10000000')
		expect(cleanNumber('3.5')).toBe('35')
		expect(cleanNumber('abc')).toBe('')
	})

	it('allows one decimal point when asked, and drops leading zeros', () => {
		expect(cleanNumber('1.2.3', { decimal: true })).toBe('1.23')
		expect(cleanNumber('.5', { decimal: true })).toBe('0.5')
		expect(cleanNumber('007')).toBe('7')
		expect(cleanNumber('0')).toBe('0')
	})

	it('caps at the maximum', () => {
		expect(cleanNumber('150', { max: 100 })).toBe('100')
		expect(cleanNumber('99', { max: 100 })).toBe('99')
	})
})

describe('stepNumber', () => {
	it('adds or takes one, like the arrow keys on a native number field', () => {
		expect(stepNumber('5', 1)).toBe('6')
		expect(stepNumber('5', -1)).toBe('4')
		expect(stepNumber('', 1)).toBe('1')
	})

	it('never goes below zero or above the maximum', () => {
		expect(stepNumber('0', -1)).toBe('0')
		expect(stepNumber('', -1)).toBe('0')
		expect(stepNumber('0.5', -1, { decimal: true })).toBe('0')
		expect(stepNumber('100', 1, { max: 100 })).toBe('100')
		expect(stepNumber('99.5', 1, { decimal: true, max: 100 })).toBe('100')
	})

	it('keeps the fraction exactly as typed', () => {
		expect(stepNumber('1.15', 1, { decimal: true })).toBe('2.15')
		expect(stepNumber('2.15', -1, { decimal: true })).toBe('1.15')
	})
})
