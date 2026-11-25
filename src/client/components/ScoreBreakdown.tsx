import { Badge } from '#client/components/ui/badge.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import type { Contribution } from '#client/domain/scores.ts'
import { formatGbp, formatInteger } from '#client/lib/format.ts'
import { describeRange, ICP_FIELD_LABELS, type IcpRule } from '#common/icp.ts'
import { SIGNAL_LABELS } from '#common/settings.ts'
import { Link } from 'react-router'

const listOf = (field: IcpRule['field'], values: string[]) =>
	values.map((value) => (field === 'signals' ? (SIGNAL_LABELS[value] ?? value) : value)).join(', ')

const describeCondition = (c: Contribution) => {
	if (c.field === 'headcount') return describeRange(c.value as [number | null, number | null], formatInteger)
	if (c.field === 'revenueGbp') return describeRange(c.value as [string | null, string | null], formatGbp)
	return `${c.op === 'any' ? 'any of' : 'one of'} ${listOf(c.field, c.value as string[])}`
}

const describeActual = (c: Contribution) => {
	if (c.actual === null) return 'unknown'
	if (Array.isArray(c.actual)) return listOf(c.field, c.actual as string[]) || 'none'
	if (c.field === 'revenueGbp') return formatGbp(c.actual as string)
	if (c.field === 'headcount') return formatInteger(c.actual as number)
	return typeof c.actual === 'string' ? c.actual : JSON.stringify(c.actual)
}

const outcomeVariant = { pass: 'secondary', fail: 'destructive', unknown: 'outline' } as const

// Rule by rule: what the ICP asks for, what the company had, and the points it earned.
export function ScoreBreakdown({ companyId, contributions }: { companyId: number; contributions: Contribution[] }) {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Rule</TableHead>
					<TableHead>Needs</TableHead>
					<TableHead>Company has</TableHead>
					<TableHead>Result</TableHead>
					<TableHead className="text-right">Points</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{contributions.map((c) => (
					<TableRow key={c.ruleId}>
						<TableCell>
							{ICP_FIELD_LABELS[c.field]}
							{c.required && <span className="text-xs text-muted-foreground"> (required)</span>}
						</TableCell>
						<TableCell className="max-w-48 text-xs whitespace-normal">{describeCondition(c)}</TableCell>
						<TableCell className="max-w-48 text-xs whitespace-normal">
							<Link
								to={`/companies/${companyId}#field-${c.field === 'revenueGbp' ? 'revenue' : c.field}`}
								className="link"
							>
								{describeActual(c)}
							</Link>
						</TableCell>
						<TableCell>
							<Badge variant={outcomeVariant[c.outcome]}>{c.outcome}</Badge>
						</TableCell>
						<TableCell className="text-right tabular-nums">
							{c.earned} / {c.points}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	)
}
