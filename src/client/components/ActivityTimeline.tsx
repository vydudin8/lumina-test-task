import { JsonView } from '#client/components/JsonView.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#client/components/ui/sheet.tsx'
import {
	actionExplanation,
	actionLabel,
	describeEvent,
	diffRows,
	entityLabel,
	flatten,
	type AuditEvent,
} from '#client/domain/audit.ts'
import { roleLabel, useUserName } from '#client/domain/session.ts'
import { formatDateTime } from '#client/lib/format.ts'
import { useFilterParams } from '#client/lib/lists.ts'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

const show = (value: unknown) => (value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value))

// The summary line opens the entry beside the list (`?event=<id>`), so Back closes it and the list keeps its place.
export function EventSummary({ event }: { event: AuditEvent }) {
	const [, update] = useFilterParams()
	return (
		<button type="button" className="link text-left" onClick={() => update({ event: String(event.id) })}>
			{/* Long edits are cut at three lines; the full text is in the entry this opens. */}
			<span className="line-clamp-3">{describeEvent(event) || 'See what changed'}</span>
		</button>
	)
}

// One audit entry in full: when, who, about what, why, what the action means, the before/after diff and the raw JSON.
export function EventSheet({ events }: { events: AuditEvent[] }) {
	const userName = useUserName()
	const [params, update] = useFilterParams()
	const event = events.find((candidate) => String(candidate.id) === params.get('event'))
	const rows = event ? diffRows(event.before, event.after) : []
	const changed = rows.filter((row) => row.changed)
	const result = event?.result == null ? [] : flatten(event.result)
	const about = event && `${entityLabel(event.entityType)} #${event.entityId}`
	const explanation = event && actionExplanation(event.action)

	return (
		<Sheet open={event !== undefined} onOpenChange={(open) => !open && update({ event: '' })}>
			<SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
				{event && (
					<>
						<SheetHeader>
							<SheetTitle>{actionLabel(event.action)}</SheetTitle>
							<SheetDescription>{describeEvent(event) || 'No summary for this kind of entry.'}</SheetDescription>
						</SheetHeader>
						<div className="space-y-6 px-4 pb-4 text-sm">
							{explanation && <p className="rounded-md border bg-muted p-3">{explanation}</p>}
							<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
								<dt className="text-muted-foreground">When</dt>
								<dd>{formatDateTime(event.at)}</dd>
								<dt className="text-muted-foreground">Who</dt>
								<dd>
									{userName(event.actorId)} ({roleLabel(event.actorRole)})
								</dd>
								<dt className="text-muted-foreground">About</dt>
								<dd>
									{event.link ? (
										<Link to={event.link} className="link">
											{about}
										</Link>
									) : (
										about
									)}
								</dd>
								{event.decision && (
									<>
										<dt className="text-muted-foreground">Decision</dt>
										<dd>{event.decision}</dd>
									</>
								)}
								{event.reason && (
									<>
										<dt className="text-muted-foreground">Reason</dt>
										<dd>{event.reason}</dd>
									</>
								)}
								<dt className="text-muted-foreground">Action code</dt>
								<dd className="font-mono text-xs">{event.action}</dd>
								<dt className="text-muted-foreground">Entry</dt>
								<dd className="font-mono text-xs break-all">
									#{event.id}
									{event.requestId && ` · request ${event.requestId}`}
								</dd>
							</dl>

							<section className="space-y-2">
								<h3 className="font-medium">What changed</h3>
								{changed.length > 0 ? (
									<div className="grid grid-cols-[auto_1fr_1fr] gap-x-4 gap-y-1 rounded-md bg-muted p-3 font-mono text-xs">
										<span className="text-muted-foreground">field</span>
										<span className="text-muted-foreground">before</span>
										<span className="text-muted-foreground">after</span>
										{changed.map((row) => (
											<div key={row.path} className="contents break-all">
												<span className="text-muted-foreground">{row.path}</span>
												<del className="text-destructive">{show(row.before)}</del>
												<ins className="text-success no-underline">{show(row.after)}</ins>
											</div>
										))}
									</div>
								) : (
									<p className="text-muted-foreground">No stored value changed with this entry.</p>
								)}
								{rows.length > changed.length && (
									<p className="text-xs text-muted-foreground">
										{rows.length - changed.length} unchanged {rows.length - changed.length === 1 ? 'value' : 'values'}{' '}
										left out.
									</p>
								)}
							</section>

							{result.length > 0 && (
								<section className="space-y-2">
									<h3 className="font-medium">Result</h3>
									<div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-muted p-3 font-mono text-xs">
										{result.map(([path, value]) => (
											<div key={path} className="contents break-all">
												<span className="text-muted-foreground">{path}</span>
												<span>{show(value)}</span>
											</div>
										))}
									</div>
								</section>
							)}

							<section className="space-y-2">
								<h3 className="font-medium">Raw JSON</h3>
								<JsonView value={{ before: event.before, after: event.after, result: event.result }} />
							</section>
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	)
}

// `self` is the page's own entity ("company:12"): events about it need no "company #12" next to them. `action` adds
// a control under an entry, such as undoing a merge.
export function ActivityTimeline({
	events,
	self,
	action,
}: {
	events: AuditEvent[]
	self?: string
	action?: (event: AuditEvent) => ReactNode
}) {
	const userName = useUserName()
	if (events.length === 0) return <p className="text-sm text-muted-foreground">Nothing has happened here yet.</p>
	return (
		<>
			<ol className="space-y-4 border-l pl-4">
				{events.map((event) => (
					<li key={event.id} className="space-y-1 text-sm">
						<p>
							<span className="font-medium">{actionLabel(event.action)}</span>
							{`${event.entityType}:${event.entityId}` !== self && (
								<span>
									{' '}
									· {entityLabel(event.entityType)} #{event.entityId}
								</span>
							)}
							<span className="text-muted-foreground">
								{' '}
								by {userName(event.actorId)} ({roleLabel(event.actorRole)}), {formatDateTime(event.at)}
							</span>
						</p>
						<p>
							<EventSummary event={event} />
						</p>
						{event.reason && <p className="text-muted-foreground">Reason: {event.reason}</p>}
						{action?.(event)}
					</li>
				))}
			</ol>
			<EventSheet events={events} />
		</>
	)
}
