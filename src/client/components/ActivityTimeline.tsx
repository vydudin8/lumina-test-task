import { formatDateTime } from '#client/format.ts'

export interface AuditEvent {
	id: number
	at: string
	actorId: string
	actorRole: string
	action: string
	entityType: string
	entityId: string
	decision: string | null
	reason: string | null
	before: unknown
	after: unknown
	result: unknown
	requestId: string | null
}

const compact = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value))

export function ActivityTimeline({ events }: { events: AuditEvent[] }) {
	if (events.length === 0) return <p className="text-sm text-muted-foreground">Nothing has happened here yet.</p>
	return (
		<ol className="space-y-3 border-l pl-4">
			{events.map((event) => (
				<li key={event.id} className="text-sm">
					<p>
						<span className="font-medium">{event.action}</span>
						{event.decision && <span> · {event.decision}</span>}
						<span className="text-muted-foreground">
							{' '}
							by {event.actorId} ({event.actorRole}), {formatDateTime(event.at)}
						</span>
					</p>
					{event.reason && <p>Reason: {event.reason}</p>}
					{[
						['Before', event.before],
						['After', event.after],
						['Result', event.result],
					].map(([label, value]) =>
						compact(value) ? (
							<p key={label as string} className="font-mono text-xs break-all text-muted-foreground">
								{label as string}: {compact(value)}
							</p>
						) : null,
					)}
				</li>
			))}
		</ol>
	)
}
