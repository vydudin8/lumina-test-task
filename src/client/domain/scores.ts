import type { IcpRule } from '#common/icp.ts'

// One ICP rule's outcome for one company, as the score API returns it.
export interface Contribution {
	ruleId: string
	field: IcpRule['field']
	op: string
	value: unknown
	required: boolean
	points: number
	earned: number
	outcome: 'pass' | 'fail' | 'unknown'
	actual: unknown
}
