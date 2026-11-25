import { EventSheet, EventSummary } from '#client/components/ActivityTimeline.tsx'
import { FilterBar, FilterDateRange, FilterSelect } from '#client/components/Filters.tsx'
import { Pager } from '#client/components/Pager.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { actionLabel, entityLabel, type AuditEvent } from '#client/domain/audit.ts'
import { roleLabel, useUserName } from '#client/domain/session.ts'
import { api } from '#client/lib/api.ts'
import { formatDateTime, formatInteger } from '#client/lib/format.ts'
import { dayStart, useCursorPages, useFilterParams } from '#client/lib/lists.ts'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Link } from 'react-router'

interface AuditResponse {
	total: number
	pageSize: number
	nextCursor: string | null
	events: (AuditEvent & { link: string | null })[]
	filters: { actors: string[]; actions: string[]; entityTypes: string[] }
}

const FILTERS = ['actor', 'action', 'entityType', 'entityId'] as const

export function AuditPage() {
	const [params, update] = useFilterParams()
	const userName = useUserName()
	// Only the filters go to the API and decide the page; `event` is the side sheet.
	const filters = new URLSearchParams()
	for (const key of FILTERS) if (params.get(key)) filters.set(key, params.get(key)!)
	// The URL keeps the picked days; the API gets this browser's midnights, the day after `to` as the exclusive end.
	const range = { from: params.get('from') ?? '', to: params.get('to') ?? '' }
	const from = dayStart(range.from)
	const to = dayStart(range.to, 1)
	if (from) filters.set('from', from)
	if (to) filters.set('to', to)
	const pages = useCursorPages('audit', filters.toString())
	const search = new URLSearchParams(filters)
	if (pages.cursor) search.set('cursor', pages.cursor)
	const query = useQuery({
		queryKey: ['audit', search.toString()],
		queryFn: () => api<AuditResponse>(`/api/audit?${search.toString()}`),
		placeholderData: keepPreviousData,
	})

	return (
		<div className="space-y-6">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
				<p className="max-w-3xl text-muted-foreground">
					Every decision and every automatic action, with who made it, why, and what happened. Entries are written in
					the same database transaction as the change itself and can never be edited or deleted.
				</p>
			</div>
			<QueryState query={query}>
				{(data) => (
					<div className="space-y-4">
						<FilterBar
							active={[...FILTERS, 'from', 'to'].some((key) => params.has(key))}
							onClear={() => update({ actor: '', action: '', entityType: '', entityId: '', from: '', to: '' })}
							count={`${formatInteger(data.total)} ${data.total === 1 ? 'entry' : 'entries'}`}
						>
							<FilterSelect
								label="Who"
								all="Anyone"
								value={params.get('actor') ?? ''}
								onChange={(value) => update({ actor: value })}
								options={data.filters.actors.map((actor) => [actor, userName(actor)])}
							/>
							<FilterSelect
								label="Action"
								all="All actions"
								value={params.get('action') ?? ''}
								onChange={(value) => update({ action: value })}
								options={data.filters.actions.map((action) => [action, actionLabel(action)])}
							/>
							<FilterSelect
								label="About"
								all="About anything"
								value={params.get('entityType') ?? ''}
								onChange={(value) => update({ entityType: value, entityId: '' })}
								options={data.filters.entityTypes.map((type) => [type, entityLabel(type)])}
							/>
							<FilterDateRange label="When" value={range} onChange={(next) => update({ ...next })} />
							{params.get('entityId') && (
								<Button size="sm" variant="outline" onClick={() => update({ entityId: '' })}>
									Only {entityLabel(params.get('entityType') ?? '')} #{params.get('entityId')}
									<X />
								</Button>
							)}
						</FilterBar>
						{/* Every column but the date is centred, so short values do not huddle at the left of wide columns. */}
						<Table className="[&_td:not(:first-child)]:text-center [&_th:not(:first-child)]:text-center">
							<TableHeader>
								<TableRow>
									<TableHead>When</TableHead>
									<TableHead>Who</TableHead>
									<TableHead>Action</TableHead>
									<TableHead>About</TableHead>
									<TableHead>Decision and reason</TableHead>
									<TableHead>What changed</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.events.map((event) => (
									<TableRow key={event.id}>
										<TableCell className="whitespace-nowrap">{formatDateTime(event.at)}</TableCell>
										<TableCell>
											{userName(event.actorId)}
											<div className="text-xs text-muted-foreground">{roleLabel(event.actorRole)}</div>
										</TableCell>
										<TableCell title={event.action} className="font-medium">
											{actionLabel(event.action)}
										</TableCell>
										<TableCell>
											{event.link ? (
												<Link to={event.link} className="link">
													{entityLabel(event.entityType)} #{event.entityId}
												</Link>
											) : (
												`${entityLabel(event.entityType)} #${event.entityId}`
											)}
										</TableCell>
										<TableCell className="max-w-56 text-sm whitespace-normal">
											{event.decision && <span className="font-medium">{event.decision}</span>}
											{event.decision && event.reason && ': '}
											{event.reason}
										</TableCell>
										<TableCell className="max-w-96 text-sm whitespace-normal">
											<EventSummary event={event} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
						<Pager
							page={pages.page}
							pageSize={data.pageSize}
							shown={data.events.length}
							total={data.total}
							onFirst={pages.page > 0 ? pages.first : null}
							onPrevious={pages.page > 0 ? pages.previous : null}
							onNext={data.nextCursor ? () => pages.next(data.nextCursor!) : null}
						/>
						<EventSheet events={data.events} />
					</div>
				)}
			</QueryState>
		</div>
	)
}
