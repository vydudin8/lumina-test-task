import { describe, expect, it } from 'vitest'
import { personKeyHash } from './person-key.ts'
import { suppressionReason } from './suppression.ts'

const now = new Date('2026-11-20T12:00:00Z')
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000)

describe('suppressionReason', () => {
	const state = {
		optOutHashes: new Set([personKeyHash('opted@x.co.uk')]),
		lastSubmitted: new Map([
			['recent@x.co.uk', daysAgo(45)],
			['edge@x.co.uk', daysAgo(90)],
			['old@x.co.uk', daysAgo(120)],
		]),
	}

	it('blocks an opt-out, matched on the email hash', () => {
		expect(suppressionReason('opted@x.co.uk', state, now)).toBe('opt_out')
	})

	it('blocks anyone submitted in the last 90 days, including day 90', () => {
		expect(suppressionReason('recent@x.co.uk', state, now)).toBe('mailed_90d')
		expect(suppressionReason('edge@x.co.uk', state, now)).toBe('mailed_90d')
	})

	it('lets through someone mailed 120 days ago or never', () => {
		expect(suppressionReason('old@x.co.uk', state, now)).toBeNull()
		expect(suppressionReason('new@x.co.uk', state, now)).toBeNull()
	})
})
