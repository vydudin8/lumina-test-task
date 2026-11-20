import { api } from '#client/api.ts'
import { QueryState } from '#client/components/QueryState.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#client/components/ui/select.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { formatDateTime } from '#client/format.ts'
import { useUserName } from '#client/session.ts'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'
import type { AuditEvent } from '../components/ActivityTimeline.tsx'

interface AuditResponse {
	total: number
	offset: number
	pageSize: number
	events: (AuditEvent & { link: string | null })[]
	filters: { actors: string[]; actions: string[]; entityTypes: string[] }
}

const compact = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value))

export function AuditPage() {
	const [params, setParams] = useSearchParams()
	const userName = useUserName()
	const query = useQuery({
		queryKey: ['audit', params.toString()],
		queryFn: () => api<AuditResponse>(`/api/audit?${params.toString()}`),
	})
	const set = (key: string, value: string) =>
		setParams((current) => {
			const next = new URLSearchParams(current)
			if (value === 'all') next.delete(key)
			else next.set(key, value)
			next.delete('offset')
			return next
		})
	const offset = Number(params.get('offset') ?? 0)

	return (
		<div className="space-y-6">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold">Audit log</h1>
				<p className="max-w-3xl text-muted-foreground">
					Every decision and every automatic action, with who made it, why, and what happened. Entries are written in
					the same database transaction as the change itself and can never be edited or deleted.
				</p>
			</div>
			<QueryState query={query}>
				{(data) => (
					<div className="space-y-4">
						<div className="flex flex-wrap items-center gap-2">
							{(
								[
									['actor', 'Who', data.filters.actors.map((actor) => [actor, userName(actor)] as const)],
									['action', 'Action', data.filters.actions.map((action) => [action, action] as const)],
									['entityType', 'About', data.filters.entityTypes.map((type) => [type, type] as const)],
								] as const
							).map(([key, label, options]) => (
								<Select key={key} value={params.get(key) ?? 'all'} onValueChange={(value) => set(key, value)}>
									<SelectTrigger aria-label={label} className="w-56">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">{label}: all</SelectItem>
										{options.map(([value, text]) => (
											<SelectItem key={value} value={value}>
												{text}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							))}
							{params.get('entityId') && (
								<Button size="sm" variant="outline" onClick={() => set('entityId', 'all')}>
									Only {params.get('entityType')} #{params.get('entityId')} ×
								</Button>
							)}
							<span className="text-sm text-muted-foreground">{data.total} entries</span>
						</div>
						<Table>
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
									<TableRow key={event.id} className="align-top">
										<TableCell className="whitespace-nowrap">{formatDateTime(event.at)}</TableCell>
										<TableCell>
											{userName(event.actorId)}
											<div className="text-xs text-muted-foreground">{event.actorRole}</div>
										</TableCell>
										<TableCell className="font-mono text-xs">{event.action}</TableCell>
										<TableCell>
											{event.link ? (
												<Link to={event.link} className="underline underline-offset-2">
													{event.entityType} #{event.entityId}
												</Link>
											) : (
												`${event.entityType} #${event.entityId}`
											)}
										</TableCell>
										<TableCell className="max-w-56 text-sm whitespace-normal">
											{event.decision && <span className="font-medium">{event.decision}</span>}
											{event.decision && event.reason && ': '}
											{event.reason}
										</TableCell>
										<TableCell className="max-w-96 font-mono text-xs break-all whitespace-normal text-muted-foreground">
											{[
												['before', event.before],
												['after', event.after],
												['result', event.result],
											]
												.filter(([, value]) => compact(value))
												.map(([label, value]) => (
													<div key={label as string}>
														{label as string}: {compact(value)}
													</div>
												))}
											{event.requestId && <div>request {event.requestId}</div>}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
						<div className="flex items-center gap-2 text-sm">
							<Button
								size="sm"
								variant="outline"
								disabled={offset === 0}
								onClick={() => set('offset', String(Math.max(0, offset - data.pageSize)) || 'all')}
							>
								Newer
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={offset + data.pageSize >= data.total}
								onClick={() =>
									setParams(
										(current) =>
											new URLSearchParams({ ...Object.fromEntries(current), offset: String(offset + data.pageSize) }),
									)
								}
							>
								Older
							</Button>
						</div>
					</div>
				)}
			</QueryState>
		</div>
	)
}
