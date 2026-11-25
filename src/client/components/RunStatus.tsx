import { Badge } from '#client/components/ui/badge.tsx'
import type { ProviderName } from '#common/settings.ts'

export interface RunError {
	kind: string
	externalId: string | null
	problem: string
	payload?: unknown
}

export interface Run {
	id: number
	provider: ProviderName
	triggeredBy: string
	status: 'queued' | 'running' | 'succeeded' | 'succeeded_with_errors' | 'failed'
	startedAt: string
	finishedAt: string | null
	recordsReceived: number
	recordsNew: number
	recordsUnchanged: number
	recordsRejected: number
	creditsUsed: string
}

export type RunWithErrors = Run & { errors: RunError[] }

const statuses = {
	queued: ['Queued', 'secondary', 'The pull is waiting for the background worker.'],
	running: ['Running', 'outline', 'The pull is still fetching pages from the provider.'],
	succeeded: ['OK', 'success', 'Every record the provider sent was stored.'],
	succeeded_with_errors: [
		'OK, some rejected',
		'warning',
		'The pull finished, but some records were malformed and not stored. The run lists them with the reason.',
	],
	failed: [
		'Failed',
		'destructive',
		'The pull stopped on an error that retries did not fix. Nothing from this pull was stored.',
	],
} as const

export function RunStatus({ run }: { run: Pick<Run, 'status'> }) {
	const [label, variant, meaning] = statuses[run.status]
	return (
		<Badge variant={variant} title={meaning}>
			{label}
		</Badge>
	)
}
