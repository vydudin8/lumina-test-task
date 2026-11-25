import { MultiCombobox } from '#client/components/MultiCombobox.tsx'
import { NumberInput } from '#client/components/NumberInput.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Checkbox } from '#client/components/ui/checkbox.tsx'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '#client/components/ui/dialog.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#client/components/ui/select.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { toast } from '#client/components/ui/toast.tsx'
import { useUserName } from '#client/domain/session.ts'
import { api } from '#client/lib/api.ts'
import { COUNTRIES } from '#client/lib/countries.ts'
import { useDebounced } from '#client/lib/debounce.ts'
import { formatDateTime, formatGbp, formatInteger } from '#client/lib/format.ts'
import { useFilterParams } from '#client/lib/lists.ts'
import { cn } from '#client/lib/utils.ts'
import { describeRange, ICP_FIELD_LABELS, icpRulesSchema, type IcpRule } from '#common/icp.ts'
import { INDUSTRY_MAP, SIGNAL_LABELS } from '#common/settings.ts'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
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
	revenueGbp: () => ({
		id: 'revenue',
		field: 'revenueGbp',
		op: 'between',
		value: ['10000000', null],
		points: 10,
		required: false,
	}),
	signals: () => ({
		id: 'signals',
		field: 'signals',
		op: 'any',
		value: Object.keys(SIGNAL_LABELS),
		points: 10,
		required: false,
	}),
}

export function IcpPage() {
	const [params] = useFilterParams()
	const version = params.get('version')
	const query = useQuery({
		queryKey: ['icp', version],
		queryFn: () => api<IcpResponse>(`/api/icp${version ? `?version=${version}` : ''}`),
		placeholderData: keepPreviousData,
	})
	return <QueryState query={query}>{(data) => <IcpEditor key={data.current.id} data={data} />}</QueryState>
}

function IcpEditor({ data }: { data: IcpResponse }) {
	const userName = useUserName()
	const queryClient = useQueryClient()
	const [, setParams] = useFilterParams()
	const latestId = data.versions[0]?.id
	const latest = data.current.id === latestId
	const [pending, setPending] = useState<number | null>(null)
	const [rules, setRules] = useState<IcpRule[]>(data.current.rules)
	const [addField, setAddField] = useState<IcpRule['field']>('industry')
	const parsed = icpRulesSchema.safeParse(rules)
	const debounced = useDebounced(rules, 300)
	const changed = JSON.stringify(rules) !== JSON.stringify(data.current.rules)
	const total = rules.reduce((sum, rule) => sum + rule.points, 0)

	const preview = useQuery({
		queryKey: ['icp-preview', debounced],
		queryFn: () => api<Preview>('/api/icp/preview', { method: 'POST', json: { rules: debounced } }),
		enabled: icpRulesSchema.safeParse(debounced).success,
		// Every edit is a new key: keep the last counts on screen instead of flashing "Loading…".
		placeholderData: keepPreviousData,
	})
	const save = useMutation({
		mutationFn: () => api<{ version: { id: number } }>('/api/icp', { method: 'POST', json: { rules } }),
		onSuccess: ({ version }) => {
			toast({ title: `ICP version ${version.id} saved` })
			setParams({ version: '' })
			return queryClient.invalidateQueries()
		},
		onError: (error) => toast({ tone: 'error', title: 'Could not save the ICP', description: error.message }),
	})

	// Opening another version replaces the rules in the editor, so unsaved edits need a yes first.
	const switchTo = (id: number) => (changed ? setPending(id) : setParams({ version: String(id) }))
	const update = (index: number, rule: IcpRule) => setRules(rules.map((current, i) => (i === index ? rule : current)))
	const uniqueId = (base: string) => {
		let id = base
		for (let n = 2; rules.some((rule) => rule.id === id); n++) id = `${base}-${n}`
		return id
	}

	return (
		<div className="space-y-8">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">Ideal customer profile</h1>
					<p className="max-w-3xl text-muted-foreground">
						A company is in the profile when it passes every required rule. Its score is the points it earns out of the
						points available. When we don't know a value, the rule earns nothing and shows as unknown rather than
						failed; an unknown required value keeps the company out.
					</p>
					<p className="text-sm">
						Version {data.current.id}, saved by {userName(data.current.createdBy)} on{' '}
						{formatDateTime(data.current.createdAt)}.
						{!latest && ' This is an older version; saving makes these rules the newest one.'}
					</p>
				</div>
				<Select value={String(data.current.id)} onValueChange={(value) => switchTo(Number(value))}>
					<SelectTrigger aria-label="ICP version" className="w-44">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{data.versions.map((option) => (
							<SelectItem key={option.id} value={String(option.id)}>
								Version {option.id}
								{option.id === latestId && ' (current)'}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
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
									<NumberInput
										max={100}
										aria-label={`Points for ${rule.id}`}
										value={String(rule.points)}
										onValueChange={(points) => update(index, { ...rule, points: Number(points) })}
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
					<span className="flex-1 px-2 text-sm text-muted-foreground">{total} points available, scaled to 0–100.</span>
					<Button variant="outline" disabled={!changed} onClick={() => setRules(data.current.rules)}>
						Revert to saved version
					</Button>
					<Button disabled={(latest && !changed) || !parsed.success || save.isPending} onClick={() => save.mutate()}>
						{save.isPending ? 'Saving…' : 'Save as a new version'}
					</Button>
				</div>
				{!parsed.success && (
					<p className="text-sm text-destructive">{parsed.error.issues.map((issue) => issue.message).join('. ')}</p>
				)}
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
												<Link to={`/companies/${row.companyId}`} className="link">
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
							<Link
								to={`/icp?version=${version.id}`}
								className="link"
								onClick={(event) => {
									if (!changed) return
									event.preventDefault()
									setPending(version.id)
								}}
							>
								Load into editor
							</Link>{' '}
							·{' '}
							<Link to={`/scores?version=${version.id}`} className="link">
								Scores with this version
							</Link>
						</li>
					))}
				</ul>
			</section>

			<Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Discard unsaved changes?</DialogTitle>
						<DialogDescription>
							Your edits to the rules are not saved. Opening another version replaces them.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setPending(null)}>
							Keep editing
						</Button>
						<Button
							variant="destructive"
							onClick={() => {
								setParams({ version: String(pending) })
								setPending(null)
							}}
						>
							Discard and switch
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
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
				<div className="max-w-md">
					<MultiCombobox
						label="Countries"
						placeholder="Search by country name or code"
						empty="No country matches."
						options={COUNTRIES}
						value={rule.value}
						onChange={(value) => onChange({ ...rule, value })}
					/>
				</div>
			)
		case 'headcount':
			return (
				<RangeEditor
					label="headcount"
					value={rule.value}
					onChange={(value) => onChange({ ...rule, value })}
					parse={(text) => (text ? Number(text) : null)}
					format={formatInteger}
				/>
			)
		case 'revenueGbp':
			return (
				<RangeEditor
					label="revenue"
					prefix="£"
					value={rule.value}
					onChange={(value) => onChange({ ...rule, value })}
					decimal
					parse={(text) => text || null}
					format={formatGbp}
				/>
			)
	}
}

// Two bounds, either one optional: an empty side means no limit.
function RangeEditor<T extends number | string>({
	label,
	value,
	onChange,
	parse,
	format,
	prefix,
	decimal = false,
}: {
	label: string
	value: [T | null, T | null]
	onChange: (value: [T | null, T | null]) => void
	parse: (text: string) => T | null
	format: (value: T) => string
	prefix?: string
	decimal?: boolean
}) {
	const bound = (index: 0 | 1) => (
		<div className="relative">
			{prefix && (
				<span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">
					{prefix}
				</span>
			)}
			<NumberInput
				className={cn('w-36', prefix && 'pl-7')}
				decimal={decimal}
				aria-label={`${index === 0 ? 'Minimum' : 'Maximum'} ${label}`}
				placeholder={index === 0 ? 'No minimum' : 'No maximum'}
				value={String(value[index] ?? '')}
				onValueChange={(text) => {
					const next: [T | null, T | null] = [...value]
					next[index] = parse(text)
					onChange(next)
				}}
			/>
		</div>
	)
	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				{bound(0)}
				<span className="text-muted-foreground">to</span>
				{bound(1)}
			</div>
			<p className="text-xs text-muted-foreground">
				{value[0] === null && value[1] === null
					? 'Set a minimum, a maximum or both.'
					: `Passes when ${label} is ${describeRange(value, format)}. An empty side means no limit.`}
			</p>
		</div>
	)
}
