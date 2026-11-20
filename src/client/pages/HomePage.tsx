import { api } from '#client/api.ts'
import { formatDateTime } from '#client/format.ts'
import { useSession } from '#client/session.ts'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

interface Overview {
	providers: { lastRun: { startedAt: string } | null; records: { company: number; contact: number } }[]
}

function Step({ number, title, to, children }: { number: number; title: string; to: string; children: ReactNode }) {
	return (
		<li className="rounded-lg border p-4">
			<p className="text-sm text-muted-foreground">Step {number}</p>
			<Link to={to} className="text-lg font-medium underline-offset-2 hover:underline">
				{title}
			</Link>
			<div className="mt-1 text-sm">{children}</div>
		</li>
	)
}

export function HomePage() {
	const { data: user } = useSession()
	const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<Overview>('/api/providers') })
	const companies = useQuery({
		queryKey: ['companies', ''],
		queryFn: () =>
			api<{
				summary: {
					companies: number
					sources: number
					conflicts: { headcount: number }
					stale: number
					possibleDuplicates: number
				}
			}>('/api/companies'),
	})
	const scores = useQuery({
		queryKey: ['scores', null],
		queryFn: () => api<{ icp: { id: number }; ranked: unknown[] }>('/api/scores'),
	})
	const campaigns = useQuery({
		queryKey: ['campaigns'],
		queryFn: () => api<{ campaigns: { id: number; name: string; status: string }[] }>('/api/campaigns'),
	})

	const records = providers.data?.providers.reduce((sum, panel) => sum + panel.records.company, 0)
	const lastPull =
		providers.data?.providers
			.map((panel) => panel.lastRun?.startedAt)
			.filter(Boolean)
			.sort()
			.at(-1) ?? null
	const loading = <span className="text-muted-foreground">Loading…</span>

	return (
		<div className="space-y-6">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold">Outbound targeting and postcards</h1>
				<p className="text-muted-foreground">
					Signed in as {user?.name}. Work through the steps in order; each page explains what it shows.
				</p>
			</div>
			<ol className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
				<Step number={1} title="Providers" to="/providers">
					{providers.data
						? `${records} company records from Apollo, FactSet and Clay. Last pull ${formatDateTime(lastPull)}.`
						: loading}
				</Step>
				<Step number={2} title="Companies" to="/companies">
					{companies.data
						? `${companies.data.summary.companies} companies after merging duplicates. ${companies.data.summary.conflicts.headcount} headcount conflicts and ${companies.data.summary.possibleDuplicates} possible duplicates to check.`
						: loading}
				</Step>
				<Step number={3} title="Ideal customer profile and scores" to="/scores">
					{scores.data
						? `ICP version ${scores.data.icp.id}: ${scores.data.ranked.length} companies in the profile, best fit first.`
						: loading}
				</Step>
				<Step number={4} title="Campaigns" to="/campaigns">
					{campaigns.data
						? `${campaigns.data.campaigns.length} campaigns. Build one from the top companies, review the cards, then a sales lead approves and sends.`
						: loading}
				</Step>
				<Step number={5} title="Suppression list" to="/suppressions">
					People who opted out or were mailed in the last 90 days. They never get a card.
				</Step>
				<Step number={6} title="Audit log" to="/audit">
					Who decided what, why, and what happened as a result.
				</Step>
			</ol>
		</div>
	)
}
