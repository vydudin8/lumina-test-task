import { JsonView } from '#client/components/JsonView.tsx'
import { Pager } from '#client/components/Pager.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { RawRecords, RecordFilters } from '#client/components/RawRecords.tsx'
import { RunStatus, type RunError, type RunWithErrors } from '#client/components/RunStatus.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#client/components/ui/sheet.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { runQuery } from '#client/domain/runs.ts'
import { useUserName } from '#client/domain/session.ts'
import { formatDateTime, formatInteger } from '#client/lib/format.ts'
import { useCursorPages, useFilterParams } from '#client/lib/lists.ts'
import { cn } from '#client/lib/utils.ts'
import { PROVIDER_LABELS } from '#common/settings.ts'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router'

const outcomes = ['all', 'new', 'unchanged', 'rejected'] as const
type Outcome = (typeof outcomes)[number]

const duration = (run: RunWithErrors) => {
	if (!run.finishedAt) return null
	const seconds = Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000)
	if (seconds < 1) return 'under 1 s'
	return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

export function RunPage() {
	const { id } = useParams()
	const [params, update] = useFilterParams()
	const outcome: Outcome = outcomes.find((value) => value === params.get('outcome')) ?? 'all'
	const run = useQuery(runQuery(id!))
	const userName = useUserName()

	return (
		<div className="space-y-6">
			<QueryState query={run}>
				{({ run }) => {
					const counts: Record<Outcome, number> = {
						all: run.recordsNew + run.recordsUnchanged,
						new: run.recordsNew,
						unchanged: run.recordsUnchanged,
						rejected: run.recordsRejected,
					}
					const took = duration(run)
					return (
						<>
							<header className="space-y-1">
								<div className="flex flex-wrap items-center gap-3">
									<h1 className="text-2xl font-semibold tracking-tight">
										{PROVIDER_LABELS[run.provider]} pull #{run.id}
									</h1>
									<RunStatus run={run} />
								</div>
								<p className="text-sm text-muted-foreground">
									{formatDateTime(run.startedAt)}
									{took && ` · took ${took}`} · by {userName(run.triggeredBy)} · {formatInteger(run.recordsReceived)}{' '}
									records received · {run.creditsUsed} credits (simulated)
								</p>
							</header>

							{run.status === 'queued' || run.status === 'running' ? (
								<p role="status" className="rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground">
									{run.status === 'queued'
										? 'This pull is waiting for the background worker.'
										: 'This pull is running. The page updates when it ends.'}
								</p>
							) : run.status === 'failed' ? (
								<p
									role="alert"
									className="rounded-lg border border-destructive/25 bg-destructive-soft p-4 text-sm text-destructive"
								>
									This pull failed and stored nothing: {run.errors[0]?.problem ?? 'no reason recorded'}.
								</p>
							) : (
								<>
									<div role="group" aria-label="Show records" className="flex flex-wrap gap-x-6 border-b">
										{outcomes.map((value) => (
											<button
												key={value}
												type="button"
												aria-pressed={outcome === value}
												onClick={() => update({ outcome: value === 'all' ? '' : value, record: '' })}
												className={cn(
													'-mb-px flex items-center gap-2 border-b-2 pt-1 pb-2.5 text-sm font-medium transition-colors focus-visible:text-foreground focus-visible:outline-none',
													outcome === value
														? 'border-link text-foreground'
														: 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
												)}
											>
												{{ all: 'All stored', new: 'New', unchanged: 'Unchanged', rejected: 'Rejected' }[value]}
												<span
													className={cn(
														'rounded-full px-1.5 py-px text-xs tabular-nums',
														value === 'rejected' && counts.rejected > 0
															? 'bg-warning-soft text-warning'
															: 'bg-muted text-muted-foreground',
													)}
												>
													{formatInteger(counts[value])}
												</span>
											</button>
										))}
									</div>
									{outcome === 'rejected' ? (
										<RejectedRecords errors={run.errors} />
									) : (
										<RawRecords scope={{ runId: run.id, outcome: outcome === 'all' ? undefined : outcome }} />
									)}
								</>
							)}
						</>
					)
				}}
			</QueryState>
		</div>
	)
}

const PAGE_SIZE = 20

// Rejected records live on the run itself (they were never stored), so they are filtered and paged in the browser.
// shortcut: the run's whole error list loads at once; page it on the server if a provider ever rejects tens of thousands.
function RejectedRecords({ errors }: { errors: RunError[] }) {
	const [params] = useFilterParams()
	const kind = params.get('kind') ?? ''
	const needle = (params.get('q') ?? '').trim().toLowerCase()
	const filterKey = `${kind}|${needle}`
	// The "cursor" of a page held in memory is simply its number.
	const pages = useCursorPages('rejected', filterKey)
	const page = pages.page
	const [open, setOpen] = useState<RunError | null>(null)

	const matches = errors.filter(
		(error) => (!kind || error.kind === kind) && (!needle || JSON.stringify(error).toLowerCase().includes(needle)),
	)
	const shown = matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

	return (
		<div className="space-y-3">
			<RecordFilters count={matches.length} />
			{errors.length === 0 ? (
				<p className="text-sm text-muted-foreground">Nothing was rejected in this pull.</p>
			) : matches.length === 0 ? (
				<p className="text-sm text-muted-foreground">No rejected records match these filters.</p>
			) : (
				<>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Type</TableHead>
								<TableHead>Problem</TableHead>
								<TableHead>Provider id</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{shown.map((error, index) => (
								<TableRow key={page * PAGE_SIZE + index} className="group" onClick={() => setOpen(error)}>
									<TableCell className="text-muted-foreground capitalize">{error.kind}</TableCell>
									<TableCell>
										<button
											type="button"
											className="text-left font-medium underline-offset-2 group-hover:underline focus-visible:underline focus-visible:outline-none"
										>
											{error.problem}
										</button>
									</TableCell>
									<TableCell className="font-mono text-xs text-muted-foreground">
										{error.externalId ?? 'no id'}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
					<Pager
						page={page}
						pageSize={PAGE_SIZE}
						shown={shown.length}
						total={matches.length}
						onFirst={page > 0 ? pages.first : null}
						onPrevious={page > 0 ? pages.previous : null}
						onNext={(page + 1) * PAGE_SIZE < matches.length ? () => pages.next(String(page + 1)) : null}
					/>
				</>
			)}
			<Sheet open={open !== null} onOpenChange={(isOpen) => !isOpen && setOpen(null)}>
				<SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
					<SheetHeader>
						<SheetTitle>{open?.problem}</SheetTitle>
						<SheetDescription>
							{open &&
								`${open.kind}, ${open.externalId ? `id ${open.externalId}` : 'no id'}. This record was not stored.`}
						</SheetDescription>
					</SheetHeader>
					<div className="px-4 pb-4">
						{open?.payload !== undefined ? (
							<JsonView value={open.payload} />
						) : (
							<p className="text-sm text-muted-foreground">The provider sent no payload for this record.</p>
						)}
					</div>
				</SheetContent>
			</Sheet>
		</div>
	)
}
