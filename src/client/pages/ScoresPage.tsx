import { api } from '#client/api.ts'
import { QueryState } from '#client/components/QueryState.tsx'
import { Badge } from '#client/components/ui/badge.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#client/components/ui/select.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { formatGbp, formatInteger } from '#client/format.ts'
import { ICP_FIELD_LABELS, type IcpRule } from '#common/icp.ts'
import { SIGNAL_LABELS } from '#common/settings.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'

interface Contribution {
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

interface Evidence {
	id: string
	label: string
	value: string
	source: string
	date: string | null
}

export interface Rationale {
	status: 'accepted' | 'rejected'
	text: string
	cites: string[]
	evidence: Evidence[]
	rejections: { code: string; detail: string }[]
	model: string
	promptVersion: string
}

interface ScoresResponse {
	icp: { id: number }
	ranked: {
		rank: number
		companyId: number
		name: string | null
		score: string
		display: number
		missed: { ruleId: string; outcome: string }[]
	}[]
	outOfProfile: { companyId: number; name: string | null; reasons: string[] }[]
}

interface ScoreDetail {
	icp: { id: number }
	company: { id: number; name: string | null }
	rank: number | null
	score: { inProfile: boolean; outReasons: string[]; score: string; display: number; contributions: Contribution[] }
	evidence: Evidence[]
	rationale: Rationale | null
}

const listOf = (field: IcpRule['field'], values: string[]) =>
	values.map((value) => (field === 'signals' ? (SIGNAL_LABELS[value] ?? value) : value)).join(', ')

const describeCondition = (c: Contribution) => {
	if (c.op === 'between') return `between ${(c.value as [number, number]).map(formatInteger).join(' and ')}`
	if (c.op === 'gte') return `at least ${formatGbp(c.value as string)}`
	if (c.op === 'lte') return `at most ${formatGbp(c.value as string)}`
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

export function RationaleView({ rationale }: { rationale: Rationale }) {
	return (
		<div className="space-y-2 text-sm">
			{rationale.status === 'accepted' ? (
				<Badge variant="secondary">Written by AI, checked against the evidence</Badge>
			) : (
				<Badge variant="destructive">
					AI text rejected: {rationale.rejections.map((rejection) => rejection.detail).join('; ')}. Template used.
				</Badge>
			)}
			<p>{rationale.text}</p>
			<p className="text-xs text-muted-foreground">
				Sources:{' '}
				{rationale.cites.map((cite) => {
					const item = rationale.evidence.find((evidence) => evidence.id === cite)
					return item ? (
						<span key={cite} className="mr-2">
							[{cite}] {item.label} = {item.value} ({item.source}
							{item.date ? `, ${item.date}` : ''})
						</span>
					) : null
				})}
			</p>
			<p className="text-xs text-muted-foreground">
				{rationale.model} · prompt {rationale.promptVersion}
			</p>
		</div>
	)
}

export function ScoresPage() {
	const [params, setParams] = useSearchParams()
	const version = params.get('version')
	const selected = params.get('company')
	const versionQuery = version ? `?version=${version}` : ''
	const scores = useQuery({
		queryKey: ['scores', version],
		queryFn: () => api<ScoresResponse>(`/api/scores${versionQuery}`),
	})
	const versions = useQuery({ queryKey: ['icp'], queryFn: () => api<{ versions: { id: number }[] }>('/api/icp') })
	const select = (companyId: number) =>
		setParams((current) => new URLSearchParams({ ...Object.fromEntries(current), company: String(companyId) }))

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold">Scores</h1>
					<p className="max-w-2xl text-muted-foreground">
						Companies in the profile, best fit first. Equal scores are ordered by company number, so the list is stable.
						The AI explanation describes the score; it never changes it.
					</p>
				</div>
				<Select
					value={version ?? String(scores.data?.icp.id ?? '')}
					onValueChange={(value) =>
						setParams((current) => new URLSearchParams({ ...Object.fromEntries(current), version: value }))
					}
				>
					<SelectTrigger aria-label="ICP version" className="w-44">
						<SelectValue placeholder="ICP version" />
					</SelectTrigger>
					<SelectContent>
						{versions.data?.versions.map((option) => (
							<SelectItem key={option.id} value={String(option.id)}>
								ICP version {option.id}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<QueryState query={scores}>
					{(data) => (
						<div className="space-y-4">
							<p className="text-sm">
								{data.ranked.length} in the profile, {data.outOfProfile.length} out (ICP version {data.icp.id})
							</p>
							<div className="max-h-[70vh] overflow-auto rounded-md border">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead className="w-12">#</TableHead>
											<TableHead>Company</TableHead>
											<TableHead className="text-right">Score</TableHead>
											<TableHead>Missed</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.ranked.map((row) => (
											<TableRow
												key={row.companyId}
												data-state={String(row.companyId) === selected ? 'selected' : undefined}
												className="cursor-pointer"
												onClick={() => select(row.companyId)}
											>
												<TableCell className="tabular-nums">{row.rank}</TableCell>
												<TableCell>
													<button type="button" className="text-left underline-offset-2 hover:underline">
														{row.name}
													</button>
												</TableCell>
												<TableCell className="text-right tabular-nums" title={`Exact: ${row.score}`}>
													{row.display}
												</TableCell>
												<TableCell className="space-x-1">
													{row.missed.map((miss) => (
														<Badge key={miss.ruleId} variant={miss.outcome === 'unknown' ? 'outline' : 'secondary'}>
															{miss.ruleId} {miss.outcome}
														</Badge>
													))}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
							<details className="text-sm">
								<summary className="cursor-pointer">Out of the profile ({data.outOfProfile.length})</summary>
								<ul className="mt-2 space-y-1">
									{data.outOfProfile.map((row) => (
										<li key={row.companyId}>
											<button
												type="button"
												className="underline-offset-2 hover:underline"
												onClick={() => select(row.companyId)}
											>
												{row.name}
											</button>{' '}
											<span className="text-muted-foreground">{row.reasons.join('; ')}</span>
										</li>
									))}
								</ul>
							</details>
						</div>
					)}
				</QueryState>

				<section aria-label="Score explanation" className="space-y-4">
					{selected ? (
						<ScoreExplanation companyId={Number(selected)} version={version} />
					) : (
						<p className="text-sm text-muted-foreground">Pick a company to see how its score adds up.</p>
					)}
				</section>
			</div>
		</div>
	)
}

function ScoreExplanation({ companyId, version }: { companyId: number; version: string | null }) {
	const queryClient = useQueryClient()
	const suffix = version ? `?version=${version}` : ''
	const detail = useQuery({
		queryKey: ['score', companyId, version],
		queryFn: () => api<ScoreDetail>(`/api/scores/${companyId}${suffix}`),
	})
	const write = useMutation({
		mutationFn: () => api<{ rationale: Rationale }>(`/api/scores/${companyId}/rationale${suffix}`, { method: 'POST' }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['score', companyId, version] }),
	})

	return (
		<QueryState query={detail}>
			{(data) => {
				const available = data.score.contributions.reduce((sum, c) => sum + c.points, 0)
				const earned = data.score.contributions.reduce((sum, c) => sum + c.earned, 0)
				return (
					<div className="space-y-4">
						<div>
							<h2 className="text-lg font-semibold">
								<Link to={`/companies/${data.company.id}`} className="underline-offset-2 hover:underline">
									{data.company.name}
								</Link>
							</h2>
							<p className="text-sm">
								{data.score.inProfile
									? `Rank ${data.rank}, score ${data.score.display}`
									: `Out of the profile: ${data.score.outReasons.join('; ')}`}{' '}
								· {earned} of {available} points = {data.score.score}
							</p>
						</div>
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
								{data.score.contributions.map((c) => (
									<TableRow key={c.ruleId}>
										<TableCell>
											{ICP_FIELD_LABELS[c.field]}
											{c.required && <span className="text-xs text-muted-foreground"> (required)</span>}
										</TableCell>
										<TableCell className="max-w-48 text-xs whitespace-normal">{describeCondition(c)}</TableCell>
										<TableCell className="max-w-48 text-xs whitespace-normal">
											<Link to={`/companies/${data.company.id}`} className="underline-offset-2 hover:underline">
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

						<div className="space-y-2 rounded-md border p-3">
							<h3 className="font-medium">Explanation</h3>
							{data.rationale ? (
								<RationaleView rationale={data.rationale} />
							) : (
								<Button size="sm" variant="outline" disabled={write.isPending} onClick={() => write.mutate()}>
									{write.isPending ? 'Writing…' : 'Write an explanation'}
								</Button>
							)}
							{write.isError && <p className="text-sm text-destructive">{write.error.message}</p>}
							<details className="text-xs text-muted-foreground">
								<summary className="cursor-pointer">Evidence the AI may use</summary>
								<ul className="mt-1 space-y-0.5">
									{data.evidence.map((item) => (
										<li key={item.id}>
											{item.id}: {item.label} = {item.value} ({item.source}
											{item.date ? `, ${item.date}` : ''})
										</li>
									))}
								</ul>
							</details>
						</div>
					</div>
				)
			}}
		</QueryState>
	)
}
