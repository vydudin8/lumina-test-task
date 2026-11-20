import { api } from '#client/api.ts'
import { JsonView } from '#client/components/JsonView.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { Badge } from '#client/components/ui/badge.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '#client/components/ui/card.tsx'
import { Input } from '#client/components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#client/components/ui/select.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#client/components/ui/sheet.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { formatDateTime, formatInteger } from '#client/format.ts'
import { CREDIT_COSTS, PROVIDER_LABELS, PROVIDERS, type ProviderName } from '#common/settings.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router'

interface RunError {
	kind: string
	externalId: string | null
	problem: string
	payload?: unknown
}

interface Run {
	id: number
	provider: ProviderName
	triggeredBy: string
	status: 'running' | 'succeeded' | 'succeeded_with_errors' | 'failed'
	startedAt: string
	finishedAt: string | null
	recordsReceived: number
	recordsNew: number
	recordsUnchanged: number
	recordsRejected: number
	creditsUsed: string
	errors: RunError[]
}

interface Panel {
	provider: ProviderName
	lastRun: Run | null
	records: { company: number; contact: number }
	runs: number
	creditsTotal: string
}

interface RawRecordRow {
	id: number
	provider: ProviderName
	kind: 'company' | 'contact'
	externalId: string
	label: string
	runId: number
	fetchedAt: string
	lastSeenAt: string
}

const statusLabels: Record<Run['status'], string> = {
	running: 'Running',
	succeeded: 'OK',
	succeeded_with_errors: 'OK, some records rejected',
	failed: 'Failed',
}

function RunStatus({ run }: { run: Run }) {
	const variant = run.status === 'failed' ? 'destructive' : run.status === 'succeeded' ? 'secondary' : 'outline'
	return <Badge variant={variant}>{statusLabels[run.status]}</Badge>
}

export function ProvidersPage() {
	const [params, setParams] = useSearchParams()
	const [errorsRun, setErrorsRun] = useState<Run | null>(null)
	const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<{ providers: Panel[] }>('/api/providers') })
	const runs = useQuery({ queryKey: ['ingestion-runs'], queryFn: () => api<{ runs: Run[] }>('/api/ingestion-runs') })

	const showRecords = (provider: ProviderName, kind: 'company' | 'contact') => {
		setParams({ provider, kind })
		document.getElementById('raw-records')?.scrollIntoView({ behavior: 'smooth' })
	}

	return (
		<div className="space-y-8">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold">Providers</h1>
				<p className="max-w-3xl text-muted-foreground">
					Where company and contact data comes from. Every pull is saved as a run, and every record keeps the exact JSON
					the provider sent. Credits are simulated from a fixed price list, not billed.
				</p>
			</div>

			<QueryState query={providers}>
				{({ providers: panels }) => (
					<div className="grid gap-4 md:grid-cols-3">
						{panels.map((panel) => (
							<ProviderPanel
								key={panel.provider}
								panel={panel}
								onShowRecords={showRecords}
								onShowErrors={setErrorsRun}
							/>
						))}
					</div>
				)}
			</QueryState>

			<section className="space-y-3">
				<h2 className="text-lg font-semibold">Runs</h2>
				<QueryState query={runs} empty="No pulls yet." isEmpty={(data) => data.runs.length === 0}>
					{(data) => <RunsTable runs={data.runs} onShowErrors={setErrorsRun} />}
				</QueryState>
			</section>

			<RawRecords params={params} setParams={setParams} />

			<Sheet open={errorsRun !== null} onOpenChange={(open) => !open && setErrorsRun(null)}>
				<SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
					<SheetHeader>
						<SheetTitle>Rejected records</SheetTitle>
						<SheetDescription>
							{errorsRun &&
								`${PROVIDER_LABELS[errorsRun.provider]} run #${errorsRun.id}, ${formatDateTime(errorsRun.startedAt)}. These records were not stored.`}
						</SheetDescription>
					</SheetHeader>
					<div className="space-y-4 px-4 pb-4">
						{errorsRun?.errors.map((error, index) => (
							<div key={index} className="space-y-2">
								<p className="text-sm">
									<span className="font-medium">{error.problem}</span>
									<span className="text-muted-foreground">
										{' '}
										({error.kind}
										{error.externalId ? `, id ${error.externalId}` : ', no id'})
									</span>
								</p>
								{error.payload !== undefined && <JsonView value={error.payload} />}
							</div>
						))}
					</div>
				</SheetContent>
			</Sheet>
		</div>
	)
}

function ProviderPanel({
	panel,
	onShowRecords,
	onShowErrors,
}: {
	panel: Panel
	onShowRecords: (provider: ProviderName, kind: 'company' | 'contact') => void
	onShowErrors: (run: Run) => void
}) {
	const queryClient = useQueryClient()
	const pull = useMutation({
		mutationFn: () => api<{ run: Run }>(`/api/providers/${panel.provider}/pull`, { method: 'POST' }),
		onSettled: () => queryClient.invalidateQueries(),
	})
	const { lastRun } = panel
	const costs = CREDIT_COSTS[panel.provider]

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between gap-2">
				<CardTitle>{PROVIDER_LABELS[panel.provider]}</CardTitle>
				{lastRun ? <RunStatus run={lastRun} /> : <Badge variant="outline">Never pulled</Badge>}
			</CardHeader>
			<CardContent className="space-y-3 text-sm">
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
					<dt className="text-muted-foreground">Last pull</dt>
					<dd>{formatDateTime(lastRun?.startedAt ?? null)}</dd>
					<dt className="text-muted-foreground">Records</dt>
					<dd>
						<button
							type="button"
							className="underline underline-offset-2"
							onClick={() => onShowRecords(panel.provider, 'company')}
						>
							{formatInteger(panel.records.company)} companies
						</button>
						{' · '}
						<button
							type="button"
							className="underline underline-offset-2"
							onClick={() => onShowRecords(panel.provider, 'contact')}
						>
							{formatInteger(panel.records.contact)} contacts
						</button>
					</dd>
					<dt className="text-muted-foreground">Credits</dt>
					<dd title={`Simulated: ${costs.company} per company record, ${costs.contact} per contact record`}>
						{lastRun ? `${lastRun.creditsUsed} last pull` : '0'} · {panel.creditsTotal} in total ({panel.runs}{' '}
						{panel.runs === 1 ? 'run' : 'runs'})
					</dd>
					<dt className="text-muted-foreground">Rejected</dt>
					<dd>
						{lastRun && lastRun.recordsRejected > 0 ? (
							<button type="button" className="underline underline-offset-2" onClick={() => onShowErrors(lastRun)}>
								{lastRun.recordsRejected} in the last pull
							</button>
						) : (
							'None in the last pull'
						)}
					</dd>
				</dl>
				<p className="text-xs text-muted-foreground">
					Simulated price: {costs.company} credit per company, {costs.contact} per contact.
				</p>
				<Button size="sm" variant="outline" disabled={pull.isPending} onClick={() => pull.mutate()}>
					{pull.isPending ? 'Pulling…' : 'Pull now'}
				</Button>
				{pull.isError && <p className="text-destructive">{pull.error.message}</p>}
				{pull.data && (
					<p className="text-muted-foreground">
						Done: {pull.data.run.recordsNew} new, {pull.data.run.recordsUnchanged} unchanged,{' '}
						{pull.data.run.recordsRejected} rejected.
					</p>
				)}
			</CardContent>
		</Card>
	)
}

function RunsTable({ runs, onShowErrors }: { runs: Run[]; onShowErrors: (run: Run) => void }) {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Started</TableHead>
					<TableHead>Provider</TableHead>
					<TableHead>Status</TableHead>
					<TableHead className="text-right">Received</TableHead>
					<TableHead className="text-right">New</TableHead>
					<TableHead className="text-right">Unchanged</TableHead>
					<TableHead className="text-right">Rejected</TableHead>
					<TableHead className="text-right">Credits</TableHead>
					<TableHead>By</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{runs.map((run) => (
					<TableRow key={run.id}>
						<TableCell>{formatDateTime(run.startedAt)}</TableCell>
						<TableCell>{PROVIDER_LABELS[run.provider]}</TableCell>
						<TableCell>
							<RunStatus run={run} />
						</TableCell>
						<TableCell className="text-right tabular-nums">{run.recordsReceived}</TableCell>
						<TableCell className="text-right tabular-nums">{run.recordsNew}</TableCell>
						<TableCell className="text-right tabular-nums">{run.recordsUnchanged}</TableCell>
						<TableCell className="text-right tabular-nums">
							{run.errors.length > 0 ? (
								<button type="button" className="underline underline-offset-2" onClick={() => onShowErrors(run)}>
									{run.recordsRejected || run.errors.length}
								</button>
							) : (
								0
							)}
						</TableCell>
						<TableCell className="text-right tabular-nums">{run.creditsUsed}</TableCell>
						<TableCell className="text-muted-foreground">{run.triggeredBy}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	)
}

function RawRecords({
	params,
	setParams,
}: {
	params: URLSearchParams
	setParams: ReturnType<typeof useSearchParams>[1]
}) {
	const provider = params.get('provider') ?? ''
	const kind = params.get('kind') ?? ''
	const q = params.get('q') ?? ''
	const offset = Number(params.get('offset') ?? 0)
	const openId = params.get('record')

	const update = (changes: Record<string, string>) => {
		const next = new URLSearchParams(params)
		for (const [key, value] of Object.entries(changes)) {
			if (value) next.set(key, value)
			else next.delete(key)
		}
		if (!('offset' in changes) && !('record' in changes)) next.delete('offset')
		setParams(next)
	}

	const search = new URLSearchParams({
		offset: String(offset),
		...(provider && { provider }),
		...(kind && { kind }),
		...(q && { q }),
	})
	const records = useQuery({
		queryKey: ['raw-records', search.toString()],
		queryFn: () =>
			api<{ total: number; pageSize: number; records: RawRecordRow[] }>(`/api/raw-records?${search.toString()}`),
	})
	const record = useQuery({
		queryKey: ['raw-record', openId],
		queryFn: () =>
			api<{ record: RawRecordRow & { payload: unknown; contentHash: string } }>(`/api/raw-records/${openId}`),
		enabled: openId !== null,
	})

	return (
		<section id="raw-records" className="space-y-3">
			<h2 className="text-lg font-semibold">Raw records</h2>
			<div className="flex flex-wrap gap-2">
				<Select value={provider || 'all'} onValueChange={(value) => update({ provider: value === 'all' ? '' : value })}>
					<SelectTrigger aria-label="Provider" className="w-40">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All providers</SelectItem>
						{PROVIDERS.map((name) => (
							<SelectItem key={name} value={name}>
								{PROVIDER_LABELS[name]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select value={kind || 'all'} onValueChange={(value) => update({ kind: value === 'all' ? '' : value })}>
					<SelectTrigger aria-label="Record type" className="w-40">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">Companies and contacts</SelectItem>
						<SelectItem value="company">Companies</SelectItem>
						<SelectItem value="contact">Contacts</SelectItem>
					</SelectContent>
				</Select>
				<Input
					aria-label="Search raw records"
					placeholder="Search name, id or any value"
					className="w-72"
					defaultValue={q}
					onKeyDown={(event) => event.key === 'Enter' && update({ q: event.currentTarget.value })}
				/>
			</div>

			<QueryState query={records} empty="No records match these filters." isEmpty={(data) => data.total === 0}>
				{(data) => (
					<>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Provider</TableHead>
									<TableHead>Type</TableHead>
									<TableHead>Name</TableHead>
									<TableHead>Provider id</TableHead>
									<TableHead>First fetched</TableHead>
									<TableHead>Last seen</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.records.map((row) => (
									<TableRow key={row.id} className="cursor-pointer" onClick={() => update({ record: String(row.id) })}>
										<TableCell>{PROVIDER_LABELS[row.provider]}</TableCell>
										<TableCell>{row.kind}</TableCell>
										<TableCell>
											<button type="button" className="text-left underline-offset-2 hover:underline">
												{row.label}
											</button>
										</TableCell>
										<TableCell className="font-mono text-xs">{row.externalId}</TableCell>
										<TableCell>{formatDateTime(row.fetchedAt)}</TableCell>
										<TableCell>{formatDateTime(row.lastSeenAt)}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
						<div className="flex items-center gap-3 text-sm">
							<span className="text-muted-foreground">
								{offset + 1}–{Math.min(offset + data.pageSize, data.total)} of {formatInteger(data.total)}
							</span>
							<Button
								size="sm"
								variant="outline"
								disabled={offset === 0}
								onClick={() => update({ offset: String(Math.max(0, offset - data.pageSize)) })}
							>
								Previous
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={offset + data.pageSize >= data.total}
								onClick={() => update({ offset: String(offset + data.pageSize) })}
							>
								Next
							</Button>
						</div>
					</>
				)}
			</QueryState>

			<Sheet open={openId !== null} onOpenChange={(open) => !open && update({ record: '' })}>
				<SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
					<SheetHeader>
						<SheetTitle>{record.data?.record.label ?? 'Raw record'}</SheetTitle>
						<SheetDescription>
							Exactly what the provider sent. Nothing here has been cleaned or merged.
						</SheetDescription>
					</SheetHeader>
					<div className="space-y-3 px-4 pb-4">
						<QueryState query={record}>
							{({ record: raw }) => (
								<>
									<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
										<dt className="text-muted-foreground">Provider</dt>
										<dd>
											{PROVIDER_LABELS[raw.provider]} {raw.kind}, id <span className="font-mono">{raw.externalId}</span>
										</dd>
										<dt className="text-muted-foreground">First fetched</dt>
										<dd>
											{formatDateTime(raw.fetchedAt)} (run #{raw.runId})
										</dd>
										<dt className="text-muted-foreground">Last seen</dt>
										<dd>{formatDateTime(raw.lastSeenAt)}</dd>
									</dl>
									<JsonView value={raw.payload} />
								</>
							)}
						</QueryState>
					</div>
				</SheetContent>
			</Sheet>
		</section>
	)
}
