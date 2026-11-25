import { describe, expect, it } from 'vitest'
import { campaignStage, defaultExpanded, groupLabel, type CampaignSummary } from './campaigns.ts'

const summary = (counts: Partial<CampaignSummary>): CampaignSummary => ({
	total: 50,
	eligible: 45,
	byStatus: {},
	blocked: {},
	llmRejected: 0,
	blockedAtSend: 0,
	variants: { A: 23, B: 22 },
	approved: 0,
	toReview: 0,
	linesPending: 0,
	linesFailed: false,
	ready: 0,
	sent: 0,
	delivered: 0,
	returned: 0,
	needsAttention: 0,
	...counts,
})

describe('campaignStage', () => {
	it('puts what needs a person first', () => {
		expect(campaignStage(summary({ needsAttention: 1, toReview: 5 })).label).toBe('Needs attention')
		expect(campaignStage(summary({ toReview: 5, ready: 3 }))).toEqual({
			label: 'In review',
			tone: 'warning',
			note: '5 to review',
		})
		expect(campaignStage(summary({ byStatus: { queued: 4 }, toReview: 5 })).label).toBe('Sending')
	})

	it('says the lines are being written until they are, before asking for a review', () => {
		expect(campaignStage(summary({ toReview: 45, linesPending: 30 }))).toEqual({
			label: 'Writing lines',
			tone: 'info',
			note: '15 of 45 personal lines written',
		})
	})

	it('says the lines stopped when the job failed, instead of writing them forever', () => {
		expect(campaignStage(summary({ toReview: 45, linesPending: 30, linesFailed: true }))).toEqual({
			label: 'Lines failed',
			tone: 'destructive',
			note: '30 cards need a line written by hand',
		})
		// Written by hand since: the failure no longer holds the campaign up.
		expect(campaignStage(summary({ toReview: 45, linesFailed: true })).label).toBe('In review')
	})

	it('reads a fully sent campaign as sent, not as zero approved', () => {
		expect(campaignStage(summary({ approved: 45, sent: 45, delivered: 40, returned: 1 }))).toEqual({
			label: 'Sent',
			tone: 'success',
			note: '40 delivered, 1 returned',
		})
		expect(campaignStage(summary({ approved: 45, ready: 45 })).label).toBe('Ready to send')
		expect(campaignStage(summary({})).label).toBe('Nothing to send')
	})
})

describe('opening cards', () => {
	it('opens only the cards that need a person', () => {
		expect(defaultExpanded({ status: 'draft' })).toBe(true)
		expect(defaultExpanded({ status: 'unconfirmed' })).toBe(true)
		expect(defaultExpanded({ status: 'delivered' })).toBe(false)
		expect(defaultExpanded({ status: 'blocked' })).toBe(false)
	})
})

describe('groupLabel', () => {
	it('names a bulk action by its count', () => {
		expect(groupLabel('card.approved', 44)).toBe('44 cards approved')
		expect(groupLabel('card.approved', 1)).toBe('Card approved')
		expect(groupLabel('llm.output_rejected', 3)).toBe('3 AI lines rejected')
		expect(groupLabel('some.new_action', 2)).toMatch(/×2$/)
	})
})
