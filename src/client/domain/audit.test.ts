import { describe, expect, test } from 'vitest'
import { actionLabel, describeEvent, diffRows, flatten } from './audit.ts'

describe('describeEvent', () => {
	test('a chosen field value reads as old value → new value with the providers', () => {
		const text = describeEvent({
			action: 'field.overridden',
			before: { headcount: { value: 620, provider: 'apollo', sourceId: 1 } },
			after: { headcount: { value: 1580, provider: 'factset', sourceId: 2 } },
			result: { chosenSourceId: 2 },
		})
		expect(text).toBe('Headcount: 620 (Apollo) → 1,580 (FactSet)')
	})

	test('a status change comes first, then what is specific to the action', () => {
		expect(
			describeEvent({
				action: 'card.submitted',
				before: { status: 'queued' },
				after: { status: 'submitted' },
				result: { mail_id: 'pc_1', attempts: 2 },
			}),
		).toBe('queued → submitted · mail id pc_1 · 2 attempts')
		expect(
			describeEvent({
				action: 'card.approved',
				before: { status: 'draft' },
				after: { status: 'approved' },
				result: { idempotencyKey: 'k', bulk: true },
			}),
		).toBe('draft → approved · bulk approval')
	})

	test('an edited line shows both versions and an approval reset as a status change', () => {
		expect(
			describeEvent({
				action: 'card.line_edited',
				before: { status: 'approved', personalLine: 'Old line' },
				after: { status: 'draft', personalLine: 'New line' },
				result: { approvalReset: true },
			}),
		).toBe('approved → draft · “Old line” → “New line”')
	})

	test('merges, splits and ICP saves get their own wording', () => {
		expect(
			describeEvent({
				action: 'company.merged',
				before: { companies: [3, 7] },
				after: { company: 3 },
				result: { records: ['apollo:A1', 'clay:C1', 'factset:F1'] },
			}),
		).toBe('#3 and #7 became company #3 · 3 provider records')
		expect(
			describeEvent({
				action: 'company.unmerged',
				before: { company: 3, records: [] },
				after: { companies: [3, 9] },
				result: { record: 'apollo:A1', company: 9 },
			}),
		).toBe('Apollo record A1 became company #9')
		expect(
			describeEvent({
				action: 'company.merge_undone',
				before: { company: 3, records: [] },
				after: { companies: [3, 7] },
				result: { mergeEventId: 40, records: ['apollo:A1', 'clay:C1', 'factset:F1'] },
			}),
		).toBe('#3 became companies #3 and #7 · 3 provider records')
		expect(
			describeEvent({
				action: 'icp.saved',
				before: { version: 1, rules: [] },
				after: { version: 2, rules: [] },
				result: { added: ['a'], removed: [], changed: ['b', 'c'] },
			}),
		).toBe('version 1 → 2 · 1 rule added, 2 rules changed')
	})

	test('an unknown action with no status says nothing rather than guessing', () => {
		expect(describeEvent({ action: 'something.new', before: null, after: { x: 1 }, result: null })).toBe('')
		expect(actionLabel('something.new')).toBe('something.new')
	})
})

describe('diffRows', () => {
	test('nested objects become dotted paths and only real changes are marked', () => {
		expect(
			diffRows({ headcount: { value: 620, provider: 'apollo' } }, { headcount: { value: 1580, provider: 'apollo' } }),
		).toEqual([
			{ path: 'headcount.value', before: 620, after: 1580, changed: true },
			{ path: 'headcount.provider', before: 'apollo', after: 'apollo', changed: false },
		])
	})

	test('a missing side is empty, not a phantom row, and arrays stay whole', () => {
		expect(diffRows(null, { name: 'Spring', ids: [1, 2] })).toEqual([
			{ path: 'name', before: undefined, after: 'Spring', changed: true },
			{ path: 'ids', before: undefined, after: [1, 2], changed: true },
		])
		expect(flatten({ a: { b: null } })).toEqual([['a.b', null]])
	})

	test('rules are matched by id, so one changed weight is one row', () => {
		const rule = (id: string, points: number) => ({ id, value: ['GB', 'IE'], points })
		const rows = diffRows({ rules: [rule('country', 10), rule('size', 20)] }, { rules: [rule('size', 30)] })
		expect(rows.filter((row) => row.changed)).toEqual([
			{ path: 'rules[country].id', before: 'country', after: undefined, changed: true },
			{ path: 'rules[country].value', before: ['GB', 'IE'], after: undefined, changed: true },
			{ path: 'rules[country].points', before: 10, after: undefined, changed: true },
			{ path: 'rules[size].points', before: 20, after: 30, changed: true },
		])
	})
})
