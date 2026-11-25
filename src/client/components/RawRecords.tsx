import { FilterBar, FilterSelect } from '#client/components/Filters.tsx'
import { JsonView } from '#client/components/JsonView.tsx'
import { Pager } from '#client/components/Pager.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { Badge } from '#client/components/ui/badge.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#client/components/ui/sheet.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { api } from '#client/lib/api.ts'
import { formatDateTime, formatInteger } from '#client/lib/format.ts'
import { useCursorPages, useFilterParams } from '#client/lib/lists.ts'
import { cn } from '#client/lib/utils.ts'
import { PROVIDER_LABELS, PROVIDERS, type ProviderName } from '#common/settings.ts'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'

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

interface RecordsPage {
	total: number
	pageSize: number
	nextCursor: string | null
	records: RawRecordRow[]
}

export function RecordFilters({ showProvider = false, count }: { showProvider?: boolean; count?: number }) {
	const [params, update] = useFilterParams()
	const provider = params.get('provider') ?? ''
	const kind = params.get('kind') ?? ''
	const q = params.get('q') ?? ''
	const active = Boolean((showProvider && provider) || kind || q)

	return (
		<FilterBar
			search={{
				label: 'Search records',
				placeholder: 'Search name, id or any value',
				value: q,
				onChange: (value) => update({ q: value }, { replace: true }),
			}}
			active={active}
			onClear={() => update({ provider: '', kind: '', q: '' })}
			count={count === undefined ? undefined : `${formatInteger(count)} ${count === 1 ? 'record' : 'records'}`}
		>
			{showProvider && (
				<FilterSelect
					label="Provider"
					all="All providers"
					value={provider}
					onChange={(value) => update({ provider: value })}
					options={PROVIDERS.map((name) => [name, PROVIDER_LABELS[name]])}
				/>
			)}
			<FilterSelect
				label="Record type"
				all="All types"
				value={kind}
				onChange={(value) => update({ kind: value })}
				options={[
					['company', 'Companies'],
					['contact', 'Contacts'],
				]}
			/>
		</FilterBar>
	)
}

// Stored provider records, optionally only those one run received. Opens any record's exact JSON in a drawer.
export function RawRecords({
	scope,
	showProvider = false,
}: {
	scope?: { runId: number; outcome?: 'new' | 'unchanged' }
	showProvider?: boolean
}) {
	const [params, update] = useFilterParams()
	const provider = showProvider ? (params.get('provider') ?? '') : ''
	const kind = params.get('kind') ?? ''
	const q = params.get('q') ?? ''

	const filters = new URLSearchParams({
		...(provider && { provider }),
		...(kind && { kind }),
		...(q && { q }),
		...(scope && { runId: String(scope.runId) }),
		...(scope?.outcome && { outcome: scope.outcome }),
	}).toString()
	const pages = useCursorPages('records', filters)
	const search = new URLSearchParams(filters)
	if (pages.cursor) search.set('cursor', pages.cursor)

	const records = useQuery({
		queryKey: ['raw-records', search.toString()],
		queryFn: () => api<RecordsPage>(`/api/raw-records?${search.toString()}`),
		placeholderData: keepPreviousData,
	})
	const showOutcome = scope !== undefined && scope.outcome === undefined

	return (
		<div className="space-y-3">
			<RecordFilters showProvider={showProvider} count={records.data?.total} />
			<QueryState query={records} empty="No records match these filters." isEmpty={(data) => data.total === 0}>
				{(data) => (
					<div className={cn('space-y-3 transition-opacity', records.isPlaceholderData && 'opacity-60')}>
						<Table>
							<TableHeader>
								<TableRow>
									{showProvider && <TableHead>Provider</TableHead>}
									<TableHead>Type</TableHead>
									<TableHead>Name</TableHead>
									<TableHead>Provider id</TableHead>
									{showOutcome && <TableHead>In this run</TableHead>}
									<TableHead>First fetched</TableHead>
									<TableHead>Last seen</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.records.map((row) => (
									<TableRow key={row.id} className="group" onClick={() => update({ record: String(row.id) })}>
										{showProvider && <TableCell>{PROVIDER_LABELS[row.provider]}</TableCell>}
										<TableCell className="text-muted-foreground capitalize">{row.kind}</TableCell>
										<TableCell>
											<button
												type="button"
												className="max-w-80 truncate text-left font-medium underline-offset-2 group-hover:underline focus-visible:underline focus-visible:outline-none"
											>
												{row.label}
											</button>
										</TableCell>
										<TableCell className="font-mono text-xs text-muted-foreground">{row.externalId}</TableCell>
										{showOutcome && (
											<TableCell>
												{row.runId === scope.runId ? (
													<Badge variant="success">New</Badge>
												) : (
													<Badge variant="secondary">Unchanged</Badge>
												)}
											</TableCell>
										)}
										<TableCell className="text-muted-foreground">{formatDateTime(row.fetchedAt)}</TableCell>
										<TableCell className="text-muted-foreground">{formatDateTime(row.lastSeenAt)}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
						<Pager
							page={pages.page}
							pageSize={data.pageSize}
							shown={data.records.length}
							total={data.total}
							onFirst={pages.page > 0 ? pages.first : null}
							onPrevious={pages.page > 0 ? pages.previous : null}
							onNext={data.nextCursor ? () => pages.next(data.nextCursor!) : null}
						/>
					</div>
				)}
			</QueryState>
		</div>
	)
}

// Mounted once in the layout: any page opens a raw record beside itself with `?record=<id>`, and Back closes it.
export function RawRecordSheet() {
	const [params, update] = useFilterParams()
	const id = params.get('record')
	const onClose = () => update({ record: '' })
	const record = useQuery({
		queryKey: ['raw-record', id],
		queryFn: () => api<{ record: RawRecordRow & { payload: unknown; contentHash: string } }>(`/api/raw-records/${id}`),
		enabled: id !== null,
	})

	return (
		<Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
			<SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
				<SheetHeader>
					<SheetTitle>{record.data?.record.label ?? 'Raw record'}</SheetTitle>
					<SheetDescription>Exactly what the provider sent. Nothing here has been cleaned or merged.</SheetDescription>
				</SheetHeader>
				<div className="space-y-4 px-4 pb-4">
					<QueryState query={record}>
						{({ record: raw }) => (
							<>
								<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
									<dt className="text-muted-foreground">Provider</dt>
									<dd>
										{PROVIDER_LABELS[raw.provider]} {raw.kind}, id{' '}
										<span className="font-mono text-xs">{raw.externalId}</span>
									</dd>
									<dt className="text-muted-foreground">First fetched</dt>
									<dd>
										{formatDateTime(raw.fetchedAt)} in{' '}
										<Link className="link" to={`/providers/runs/${raw.runId}`}>
											run #{raw.runId}
										</Link>
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
	)
}
