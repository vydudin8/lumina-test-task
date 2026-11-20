import { api } from '#client/api.ts'
import { QueryState } from '#client/components/QueryState.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Checkbox } from '#client/components/ui/checkbox.tsx'
import { Input } from '#client/components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#client/components/ui/select.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { formatDateTime } from '#client/format.ts'
import { useUserName } from '#client/session.ts'
import { ICP_FIELD_LABELS, icpRulesSchema, type IcpRule } from '#common/icp.ts'
import { INDUSTRY_MAP, SIGNAL_LABELS } from '#common/settings.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'

interface IcpResponse {
	current: { id: number; rules: IcpRule[]; createdBy: string; createdAt: string }
	versions: { id: number; createdBy: string; createdAt: string }[]
}

interface Preview {
	inProfile: number
	outOfProfile: number
	reasons: { reason: string; count: number }[]
	top: { companyId: number; name: string | null; display: number }[]
}

const INDUSTRIES = [...new Set(Object.values(INDUSTRY_MAP))]

const NEW_RULES: Record<IcpRule['field'], () => IcpRule> = {
	industry: () => ({
		id: 'industry',
		field: 'industry',
		op: 'in',
		value: ['Construction'],
		points: 10,
		required: false,
	}),
	country: () => ({ id: 'country', field: 'country', op: 'in', value: ['GB'], points: 10, required: false }),
	headcount: () => ({
		id: 'headcount',
		field: 'headcount',
		op: 'between',
		value: [50, 5000],
		points: 10,
		required: false,
	}),
	revenueGbp: () => ({ id: 'revenue', field: 'revenueGbp', op: 'gte', value: '10000000', points: 10, required: false }),
	signals: () => ({
		id: 'signals',
		field: 'signals',
		op: 'any',
		value: Object.keys(SIGNAL_LABELS),
		points: 10,
		required: false,
	}),
}

function useDebounced<T>(value: T, ms: number) {
	const [debounced, setDebounced] = useState(value)
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), ms)
		return () => clearTimeout(timer)
	}, [value, ms])
	return debounced
}

export function IcpPage() {
	const query = useQuery({ queryKey: ['icp'], queryFn: () => api<IcpResponse>('/api/icp') })
	return <QueryState query={query}>{(data) => <IcpEditor key={data.current.id} data={data} />}</QueryState>
}

function IcpEditor({ data }: { data: IcpResponse }) {
	const userName = useUserName()
	const queryClient = useQueryClient()
	const [rules, setRules] = useState<IcpRule[]>(data.current.rules)
	const [addField, setAddField] = useState<IcpRule['field']>('industry')
	const parsed = icpRulesSchema.safeParse(rules)
	const debounced = useDebounced(rules, 300)
	const changed = JSON.stringify(rules) !== JSON.stringify(data.current.rules)

	const preview = useQuery({
		queryKey: ['icp-preview', debounced],
		queryFn: () => api<Preview>('/api/icp/preview', { method: 'POST', json: { rules: debounced } }),
		enabled: icpRulesSchema.safeParse(debounced).success,
	})
	const save = useMutation({
		mutationFn: () => api<{ version: { id: number } }>('/api/icp', { method: 'POST', json: { rules } }),
		onSuccess: () => queryClient.invalidateQueries(),
	})

	const update = (index: number, rule: IcpRule) => setRules(rules.map((current, i) => (i === index ? rule : current)))
	const uniqueId = (base: string) => {
		let id = base
		for (let n = 2; rules.some((rule) => rule.id === id); n++) id = `${base}-${n}`
		return id
	}

	return (
		<div className="space-y-8">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold">Ideal customer profile</h1>
				<p className="max-w-3xl text-muted-foreground">
					A company is in the profile when it passes every required rule. Its score is the points it earns out of the
					points available. When we don't know a value, the rule earns nothing and shows as unknown rather than failed;
					an unknown required value keeps the company out.
				</p>
				<p className="text-sm">
					Version {data.current.id}, saved by {userName(data.current.createdBy)} on{' '}
					{formatDateTime(data.current.createdAt)}.
				</p>
			</div>

			<section className="space-y-3">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Rule</TableHead>
							<TableHead>Condition</TableHead>
							<TableHead className="w-28">Points</TableHead>
							<TableHead>Required</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{rules.map((rule, index) => (
							<TableRow key={index} className="align-top">
								<TableCell className="font-medium">
									{ICP_FIELD_LABELS[rule.field]}
									<div className="font-mono text-xs text-muted-foreground">{rule.id}</div>
								</TableCell>
								<TableCell className="whitespace-normal">
									<ConditionEditor rule={rule} onChange={(next) => update(index, next)} />
								</TableCell>
								<TableCell>
									<Input
										type="number"
										min={0}
										max={100}
										aria-label={`Points for ${rule.id}`}
										value={rule.points}
										onChange={(event) => update(index, { ...rule, points: Number(event.target.value) })}
									/>
								</TableCell>
								<TableCell>
									<Checkbox
										aria-label={`${rule.id} is required`}
										checked={rule.required}
										onCheckedChange={(checked) => update(index, { ...rule, required: checked === true })}
									/>
								</TableCell>
								<TableCell>
									<Button size="sm" variant="ghost" onClick={() => setRules(rules.filter((_, i) => i !== index))}>
										Remove
									</Button>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
				<div className="flex flex-wrap items-center gap-2">
					<Select value={addField} onValueChange={(value) => setAddField(value as IcpRule['field'])}>
						<SelectTrigger aria-label="Field for a new rule" className="w-44">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(ICP_FIELD_LABELS).map(([field, label]) => (
								<SelectItem key={field} value={field}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						variant="outline"
						onClick={() => setRules([...rules, { ...NEW_RULES[addField](), id: uniqueId(NEW_RULES[addField]().id) }])}
					>
						Add rule
					</Button>
					<span className="flex-1" />
					<Button variant="outline" disabled={!changed} onClick={() => setRules(data.current.rules)}>
						Undo changes
					</Button>
					<Button disabled={!changed || !parsed.success || save.isPending} onClick={() => save.mutate()}>
						{save.isPending ? 'Saving…' : 'Save as a new version'}
					</Button>
				</div>
				{!parsed.success && (
					<p className="text-sm text-destructive">{parsed.error.issues.map((issue) => issue.message).join('. ')}</p>
				)}
				{save.isError && <p className="text-sm text-destructive">{save.error.message}</p>}
			</section>

			<section className="space-y-2" aria-live="polite">
				<h2 className="text-lg font-semibold">With these rules</h2>
				{!parsed.success ? (
					<p className="text-sm text-muted-foreground">Fix the rules above to see the counts.</p>
				) : (
					<QueryState query={preview}>
						{(result) => (
							<div className="grid gap-6 md:grid-cols-2">
								<div className="space-y-2 text-sm">
									<p className="text-base">
										<strong>{result.inProfile}</strong> companies in the profile, <strong>{result.outOfProfile}</strong>{' '}
										out
										{changed && <span className="text-muted-foreground"> (not saved yet)</span>}
									</p>
									<p className="font-medium">Why companies are out</p>
									<ul className="space-y-1">
										{result.reasons.slice(0, 8).map((reason) => (
											<li key={reason.reason}>
												{reason.count} × {reason.reason}
											</li>
										))}
									</ul>
								</div>
								<div className="text-sm">
									<p className="font-medium">Top 10</p>
									<ol className="list-decimal space-y-1 pl-5">
										{result.top.map((row) => (
											<li key={row.companyId}>
												<Link to={`/companies/${row.companyId}`} className="underline-offset-2 hover:underline">
													{row.name}
												</Link>{' '}
												<span className="text-muted-foreground">{row.display}</span>
											</li>
										))}
									</ol>
								</div>
							</div>
						)}
					</QueryState>
				)}
			</section>

			<section className="space-y-2">
				<h2 className="text-lg font-semibold">Versions</h2>
				<ul className="space-y-1 text-sm">
					{data.versions.map((version) => (
						<li key={version.id}>
							Version {version.id} · {userName(version.createdBy)} · {formatDateTime(version.createdAt)} ·{' '}
							<Link to={`/scores?version=${version.id}`} className="underline underline-offset-2">
								Scores with this version
							</Link>
						</li>
					))}
				</ul>
			</section>
		</div>
	)
}

function ConditionEditor({ rule, onChange }: { rule: IcpRule; onChange: (rule: IcpRule) => void }) {
	const toggle = (list: string[], item: string, on: boolean) =>
		on ? [...list, item] : list.filter((value) => value !== item)

	switch (rule.field) {
		case 'industry':
			return (
				<div className="flex flex-wrap gap-x-4 gap-y-1">
					{INDUSTRIES.map((industry) => (
						<label key={industry} className="flex items-center gap-1.5 text-sm">
							<Checkbox
								checked={rule.value.includes(industry)}
								onCheckedChange={(on) => onChange({ ...rule, value: toggle(rule.value, industry, on === true) })}
							/>
							{industry}
						</label>
					))}
				</div>
			)
		case 'signals':
			return (
				<div className="flex flex-wrap gap-x-4 gap-y-1">
					<span className="text-sm text-muted-foreground">Any of:</span>
					{Object.entries(SIGNAL_LABELS).map(([signal, label]) => (
						<label key={signal} className="flex items-center gap-1.5 text-sm">
							<Checkbox
								checked={rule.value.includes(signal)}
								onCheckedChange={(on) => onChange({ ...rule, value: toggle(rule.value, signal, on === true) })}
							/>
							{label}
						</label>
					))}
				</div>
			)
		case 'country':
			return (
				<label className="flex items-center gap-2 text-sm">
					One of
					<Input
						className="w-40"
						aria-label="Country codes"
						value={rule.value.join(', ')}
						onChange={(event) =>
							onChange({
								...rule,
								value: event.target.value
									.split(',')
									.map((code) => code.trim().toUpperCase())
									.filter(Boolean),
							})
						}
					/>
					<span className="text-muted-foreground">ISO codes, e.g. GB, IE</span>
				</label>
			)
		case 'headcount':
			return (
				<div className="flex items-center gap-2 text-sm">
					Between
					<Input
						className="w-28"
						type="number"
						aria-label="Minimum headcount"
						value={rule.value[0]}
						onChange={(event) => onChange({ ...rule, value: [Number(event.target.value), rule.value[1]] })}
					/>
					and
					<Input
						className="w-28"
						type="number"
						aria-label="Maximum headcount"
						value={rule.value[1]}
						onChange={(event) => onChange({ ...rule, value: [rule.value[0], Number(event.target.value)] })}
					/>
				</div>
			)
		case 'revenueGbp':
			return (
				<div className="flex items-center gap-2 text-sm">
					<Select value={rule.op} onValueChange={(op) => onChange({ ...rule, op: op as 'gte' | 'lte' })}>
						<SelectTrigger aria-label="Revenue comparison" className="w-32">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="gte">At least</SelectItem>
							<SelectItem value="lte">At most</SelectItem>
						</SelectContent>
					</Select>
					£
					<Input
						className="w-40"
						aria-label="Revenue in pounds"
						inputMode="decimal"
						value={rule.value}
						onChange={(event) => onChange({ ...rule, value: event.target.value.trim() })}
					/>
				</div>
			)
	}
}
