import { api } from '#client/api.ts'
import { QueryState } from '#client/components/QueryState.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { formatDate } from '#client/format.ts'
import { ATTRIBUTION_WINDOW_DAYS } from '#common/settings.ts'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

interface VariantResult {
	sent: number
	delivered: number
	returned: number
	replies: number
	visits: number
	meetings: number
	replyRate: string | null
	visitRate: string | null
	meetingRate: string | null
}

interface Results {
	summary: { byVariant: { A: VariantResult; B: VariantResult }; outsideWindow: number; tooSmallToConclude: boolean }
	events: {
		eventId: number
		kind: 'reply' | 'visit' | 'meeting'
		occurredAt: string
		cardId: number
		variant: 'A' | 'B' | null
		counted: boolean
		daysAfterMailing: number
	}[]
}

const ROWS: {
	label: string
	key: keyof VariantResult
	rate?: keyof VariantResult
	kind?: 'reply' | 'visit' | 'meeting'
}[] = [
	{ label: 'Sent', key: 'sent' },
	{ label: 'Delivered', key: 'delivered' },
	{ label: 'Returned', key: 'returned' },
	{ label: 'Replies', key: 'replies', rate: 'replyRate', kind: 'reply' },
	{ label: 'Website visits', key: 'visits', rate: 'visitRate', kind: 'visit' },
	{ label: 'Meetings', key: 'meetings', rate: 'meetingRate', kind: 'meeting' },
]

export function CampaignResults({
	campaignId,
	companyOf,
}: {
	campaignId: number
	companyOf: (cardId: number) => string
}) {
	const query = useQuery({
		queryKey: ['results', campaignId],
		queryFn: () => api<Results>(`/api/campaigns/${campaignId}/results`),
		refetchInterval: 5000,
	})
	const [focus, setFocus] = useState<{ variant: 'A' | 'B'; kind: 'reply' | 'visit' | 'meeting' } | null>(null)

	return (
		<section className="space-y-3">
			<h2 className="text-lg font-semibold">Results</h2>
			<p className="max-w-3xl text-sm text-muted-foreground">
				A reply, visit or meeting counts for a card when it comes from the same company or person within{' '}
				{ATTRIBUTION_WINDOW_DAYS} days after the card was mailed. Rates are per card sent.
			</p>
			<QueryState query={query}>
				{({ summary, events }) => (
					<div className="space-y-3">
						<Table className="max-w-xl">
							<TableHeader>
								<TableRow>
									<TableHead />
									<TableHead className="text-right">Template A</TableHead>
									<TableHead className="text-right">Template B</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{ROWS.map((row) => (
									<TableRow key={row.key}>
										<TableCell>{row.label}</TableCell>
										{(['A', 'B'] as const).map((variant) => {
											const value = summary.byVariant[variant]
											const count = value[row.key] as number
											const rate = row.rate ? (value[row.rate] as string | null) : null
											return (
												<TableCell key={variant} className="text-right tabular-nums">
													{row.kind && count > 0 ? (
														<button
															type="button"
															className="underline underline-offset-2"
															onClick={() => setFocus({ variant, kind: row.kind! })}
														>
															{count}
														</button>
													) : (
														count
													)}
													{rate !== null && <span className="text-muted-foreground"> ({rate}%)</span>}
												</TableCell>
											)
										})}
									</TableRow>
								))}
							</TableBody>
						</Table>
						{summary.tooSmallToConclude && (
							<p className="text-sm">
								Sample too small to conclude: each template needs at least 100 cards sent before a difference like this
								means much.
							</p>
						)}
						{focus && (
							<div className="text-sm">
								<p className="font-medium">
									{focus.kind === 'reply' ? 'Replies' : focus.kind === 'visit' ? 'Website visits' : 'Meetings'} counted
									for template {focus.variant}
								</p>
								<ul className="space-y-0.5">
									{events
										.filter((event) => event.counted && event.variant === focus.variant && event.kind === focus.kind)
										.map((event) => (
											<li key={event.eventId}>
												{formatDate(event.occurredAt)} · {companyOf(event.cardId)} · day {event.daysAfterMailing} after
												mailing
											</li>
										))}
								</ul>
							</div>
						)}
						{summary.outsideWindow > 0 && (
							<details className="text-sm">
								<summary className="cursor-pointer">
									{summary.outsideWindow} {summary.outsideWindow === 1 ? 'event' : 'events'} after the{' '}
									{ATTRIBUTION_WINDOW_DAYS}-day window (not counted)
								</summary>
								<ul className="mt-1 space-y-0.5 text-muted-foreground">
									{events
										.filter((event) => !event.counted)
										.map((event) => (
											<li key={event.eventId}>
												{event.kind} from {companyOf(event.cardId)} on {formatDate(event.occurredAt)}, day{' '}
												{event.daysAfterMailing} after mailing
											</li>
										))}
								</ul>
							</details>
						)}
					</div>
				)}
			</QueryState>
		</section>
	)
}
