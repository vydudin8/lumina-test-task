import { FilterSelect } from '#client/components/Filters.tsx'
import { Pager } from '#client/components/Pager.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { RawRecords } from '#client/components/RawRecords.tsx'
import { RunStatus, type Run, type RunWithErrors } from '#client/components/RunStatus.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '#client/components/ui/card.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { toast, updateToast, type ToastInput } from '#client/components/ui/toast.tsx'
import { runQuery } from '#client/domain/runs.ts'
import { useUserName } from '#client/domain/session.ts'
import { api } from '#client/lib/api.ts'
import { formatDateTime, formatInteger } from '#client/lib/format.ts'
import { useCursorPages } from '#client/lib/lists.ts'
import { cn } from '#client/lib/utils.ts'
import { CREDIT_COSTS, PROVIDER_LABELS, PROVIDERS, type ProviderName } from '#common/settings.ts'
import {
	keepPreviousData,
	QueryObserver,
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from '@tanstack/react-query'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'

interface Panel {
	provider: ProviderName
	lastRun: Run | null
	// A pull that is queued or running now; lastRun stays the last one that ended.
	activeRun: Run | null
	records: { company: number; contact: number }
	runs: number
	creditsTotal: string
}

interface RunsPage {
	total: number
	pageSize: number
	nextCursor: string | null
	runs: Run[]
}

const runPath = (run: Pick<Run, 'id'>, outcome?: string) =>
	`/providers/runs/${run.id}${outcome ? `?outcome=${outcome}` : ''}`

const endedToast = (label: string, run: RunWithErrors): ToastInput => {
	const action = { label: 'View run', to: runPath(run) }
	if (run.status === 'failed')
		return { tone: 'error', title: `${label} pull failed`, description: run.errors[0]?.problem, action }
	const rejected = run.recordsRejected > 0 ? `, ${formatInteger(run.recordsRejected)} rejected` : ''
	return {
		title: `${label} pull finished`,
		description: `${formatInteger(run.recordsNew)} new, ${formatInteger(run.recordsUnchanged)} unchanged${rejected}.`,
		action,
	}
}

// Outside any component, so the toast still gets its result after the user leaves the page. The run's query is
// active while this watches it, so the server's notices refetch it.
function followRun(queryClient: QueryClient, runId: number, onEnd: (run: RunWithErrors) => void) {
	const observer = new QueryObserver(queryClient, runQuery(String(runId)))
	const unsubscribe = observer.subscribe(({ data }) => {
		if (!data || data.run.status === 'queued' || data.run.status === 'running') return
		unsubscribe()
		onEnd(data.run)
	})
}

export function ProvidersPage() {
	const [, setParams] = useSearchParams()
	const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<{ providers: Panel[] }>('/api/providers') })

	const showRecords = (provider: ProviderName, kind: 'company' | 'contact') => {
		setParams({ provider, kind })
		document.getElementById('raw-records')?.scrollIntoView({ behavior: 'smooth' })
	}

	return (
		<div className="space-y-10">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
				<p className="max-w-3xl text-muted-foreground">
					Where company and contact data comes from. Every pull is saved as a run, and every record keeps the exact JSON
					the provider sent. Credits are simulated from a fixed price list, not billed.
				</p>
			</div>

			<QueryState query={providers}>
				{({ providers: panels }) => (
					<div className="grid gap-4 md:grid-cols-3">
						{panels.map((panel) => (
							<ProviderPanel key={panel.provider} panel={panel} onShowRecords={showRecords} />
						))}
					</div>
				)}
			</QueryState>

			<Runs />

			<section id="raw-records" className="scroll-mt-20 space-y-3">
				<h2 className="text-lg font-semibold tracking-tight">Raw records</h2>
				<RawRecords showProvider />
			</section>
		</div>
	)
}

function ProviderPanel({
	panel,
	onShowRecords,
}: {
	panel: Panel
	onShowRecords: (provider: ProviderName, kind: 'company' | 'contact') => void
}) {
	const queryClient = useQueryClient()
	const label = PROVIDER_LABELS[panel.provider]
	const pull = useMutation({
		mutationFn: () => api<{ run: Run }>(`/api/providers/${panel.provider}/pull`, { method: 'POST' }),
		// The pull runs in the background; the panel, the run lists and this toast follow it as the server reports.
		onSuccess: ({ run }) => {
			const id = toast({
				tone: 'pending',
				title: `${label} pull started`,
				description: 'It runs in the background.',
				action: { label: 'View run', to: runPath(run) },
			})
			followRun(queryClient, run.id, (ended) => updateToast(id, endedToast(label, ended)))
		},
		onError: (error) => toast({ tone: 'error', title: `${label} pull failed`, description: error.message }),
		onSettled: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
	})
	const { lastRun, activeRun } = panel
	const pulling = pull.isPending || activeRun !== null
	const costs = CREDIT_COSTS[panel.provider]

	return (
		<Card>
			<CardHeader className="flex flex-row items-start justify-between gap-2">
				<div className="space-y-1.5">
					<CardTitle className="text-base">{label}</CardTitle>
					<p className="text-xs text-muted-foreground">
						{lastRun ? (
							<>
								Last pull{' '}
								<Link className="link" to={runPath(lastRun)}>
									{formatDateTime(lastRun.startedAt)}
								</Link>
							</>
						) : (
							'Never pulled'
						)}
					</p>
				</div>
				{(activeRun ?? lastRun) && <RunStatus run={(activeRun ?? lastRun)!} />}
			</CardHeader>
			<CardContent className="space-y-4 text-sm">
				<div className="flex flex-wrap gap-x-6 gap-y-1">
					{(['company', 'contact'] as const).map((kind) => (
						<button
							key={kind}
							type="button"
							className="group rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
							onClick={() => onShowRecords(panel.provider, kind)}
						>
							<span className="text-xl font-semibold tabular-nums group-hover:text-link">
								{formatInteger(panel.records[kind])}
							</span>{' '}
							<span className="text-link underline-offset-3 group-hover:underline">
								{kind === 'company' ? 'companies' : 'contacts'}
							</span>
						</button>
					))}
				</div>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
					<dt className="text-muted-foreground">Credits</dt>
					<dd>
						{lastRun ? `${lastRun.creditsUsed} last pull` : '0'} · {panel.creditsTotal} in total ({panel.runs}{' '}
						{panel.runs === 1 ? 'run' : 'runs'})
					</dd>
					<dt className="text-muted-foreground">Rejected</dt>
					<dd>
						{lastRun && lastRun.recordsRejected > 0 ? (
							<Link className="link" to={runPath(lastRun, 'rejected')}>
								{lastRun.recordsRejected} in the last pull
							</Link>
						) : (
							'None in the last pull'
						)}
					</dd>
				</dl>
			</CardContent>
			<CardFooter className="mt-auto justify-between gap-3 border-t">
				<span className="text-xs text-muted-foreground">
					Simulated: {costs.company} credit per company, {costs.contact} per contact
				</span>
				<Button size="sm" variant="outline" disabled={pulling} onClick={() => pull.mutate()}>
					{pulling ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
					{activeRun?.status === 'queued' ? 'Queued…' : pulling ? 'Pulling…' : 'Pull now'}
				</Button>
			</CardFooter>
		</Card>
	)
}

function Runs() {
	const [provider, setProvider] = useState('')
	const filters = provider ? `provider=${provider}` : ''
	const pages = useCursorPages('runs', filters)
	const search = new URLSearchParams(filters)
	if (pages.cursor) search.set('cursor', pages.cursor)
	const runs = useQuery({
		queryKey: ['ingestion-runs', search.toString()],
		queryFn: () => api<RunsPage>(`/api/ingestion-runs?${search.toString()}`),
		placeholderData: keepPreviousData,
	})
	const navigate = useNavigate()
	const userName = useUserName()

	return (
		<section className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<h2 className="mr-auto text-lg font-semibold tracking-tight">Runs</h2>
				<FilterSelect
					label="Runs of provider"
					all="All providers"
					value={provider}
					onChange={setProvider}
					options={PROVIDERS.map((name) => [name, PROVIDER_LABELS[name]])}
				/>
			</div>
			<QueryState query={runs} empty="No pulls yet." isEmpty={(data) => data.total === 0}>
				{(data) => (
					<div className={cn('space-y-3 transition-opacity', runs.isPlaceholderData && 'opacity-60')}>
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
								{data.runs.map((run) => (
									<TableRow
										key={run.id}
										// The links inside navigate on their own; anywhere else on the row opens the run.
										onClick={(event) => !(event.target as Element).closest('a') && void navigate(runPath(run))}
									>
										<TableCell>
											<Link className="link" to={runPath(run)}>
												{formatDateTime(run.startedAt)}
											</Link>
										</TableCell>
										<TableCell>{PROVIDER_LABELS[run.provider]}</TableCell>
										<TableCell>
											<RunStatus run={run} />
										</TableCell>
										<TableCell className="text-right">{formatInteger(run.recordsReceived)}</TableCell>
										<TableCell className="text-right">{formatInteger(run.recordsNew)}</TableCell>
										<TableCell className="text-right">{formatInteger(run.recordsUnchanged)}</TableCell>
										<TableCell className="text-right">
											{run.recordsRejected > 0 ? (
												<Link className="link" to={runPath(run, 'rejected')}>
													{formatInteger(run.recordsRejected)}
												</Link>
											) : (
												<span className="text-muted-foreground">0</span>
											)}
										</TableCell>
										<TableCell className="text-right">{run.creditsUsed}</TableCell>
										<TableCell className="text-muted-foreground">{userName(run.triggeredBy)}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
						<Pager
							page={pages.page}
							pageSize={data.pageSize}
							shown={data.runs.length}
							total={data.total}
							onFirst={pages.page > 0 ? pages.first : null}
							onPrevious={pages.page > 0 ? pages.previous : null}
							onNext={data.nextCursor ? () => pages.next(data.nextCursor!) : null}
						/>
					</div>
				)}
			</QueryState>
		</section>
	)
}
