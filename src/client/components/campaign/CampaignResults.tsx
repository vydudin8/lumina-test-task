import { QueryState } from '#client/components/QueryState.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#client/components/ui/sheet.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '#client/components/ui/tooltip.tsx'
import { api } from '#client/lib/api.ts'
import { formatDate } from '#client/lib/format.ts'
import { cn } from '#client/lib/utils.ts'
import { ATTRIBUTION_WINDOW_DAYS, MIN_SAMPLE_PER_VARIANT } from '#common/settings.ts'
import { useQuery } from '@tanstack/react-query'
import Decimal from 'decimal.js'
import { Info } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, type To } from 'react-router'

interface VariantResult {
	sent: number
	delivered: number
	returned: number
	// Cards with at least one such event in the window, not events: the rates are shares of cards sent.
	replies: number
	visits: number
	meetings: number
	replyRate: string | null
	visitRate: string | null
	meetingRate: string | null
}

type Kind = 'reply' | 'visit' | 'meeting'
type Variant = 'A' | 'B'

interface Results {
	summary: { byVariant: Record<Variant, VariantResult>; outsideWindow: number; tooSmallToConclude: boolean }
	events: {
		eventId: number
		kind: Kind
		occurredAt: string
		cardId: number
		companyName: string | null
		variant: Variant | null
		counted: boolean
		daysAfterMailing: number
	}[]
}

// Replies, visits and meetings are separate outcomes, not steps after delivery (a returned card's company can still
// reply), so each is a share of cards sent, the way the server computes it.
const OUTCOMES: {
	kind: Kind
	label: string
	count: 'replies' | 'visits' | 'meetings'
	rate: 'replyRate' | 'visitRate' | 'meetingRate'
	noun: [string, string]
	outcome: string
}[] = [
	{
		kind: 'reply',
		label: 'Replies',
		count: 'replies',
		rate: 'replyRate',
		noun: ['reply', 'replies'],
		outcome: 'got a reply',
	},
	// Short label: the column header stays on one line next to an A/B template column.
	{
		kind: 'visit',
		label: 'Visits',
		count: 'visits',
		rate: 'visitRate',
		noun: ['website visit', 'website visits'],
		outcome: 'led to a website visit',
	},
	{
		kind: 'meeting',
		label: 'Meetings',
		count: 'meetings',
		rate: 'meetingRate',
		noun: ['meeting', 'meetings'],
		outcome: 'led to a meeting',
	},
]
const KIND_LABEL: Record<Kind, string> = { reply: 'Reply', visit: 'Website visit', meeting: 'Meeting' }
// One fixed colour per template, so A and B keep their colour whichever is shown.
const TONE: Record<Variant, { fill: string; track: string; dot: string }> = {
	A: { fill: 'bg-chart-1', track: 'bg-chart-1/15', dot: 'bg-chart-1' },
	B: { fill: 'bg-chart-2', track: 'bg-chart-2/15', dot: 'bg-chart-2' },
}

const plural = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`
// Same rounding and shape as the server's rates (pipeline/results/core.ts).
const percent = (part: number, whole: number) =>
	whole === 0 ? '0' : new Decimal(part).div(whole).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toString()

export function CampaignResults({
	campaignId,
	templateNames,
	cardLink,
	onShowCards,
}: {
	campaignId: number
	// No B: the campaign ran without an A/B test.
	templateNames: { A: string; B?: string }
	// The page owns the card list: a company opens its card there, Sent and Delivered filter it.
	cardLink: (cardId: number) => To
	onShowCards: (view: 'sent' | 'delivered', variant: Variant) => void
}) {
	const query = useQuery({
		queryKey: ['results', campaignId],
		queryFn: () => api<Results>(`/api/campaigns/${campaignId}/results`),
	})
	const [focus, setFocus] = useState<{ variant: Variant; kind: Kind } | 'late' | null>(null)
	const variants: Variant[] = templateNames.B ? ['A', 'B'] : ['A']
	const ab = variants.length > 1
	const nameOf = (variant: Variant) => templateNames[variant] ?? `Template ${variant}`

	return (
		<section aria-labelledby="results-heading" className="space-y-1.5">
			<QueryState query={query}>
				{({ summary, events }) => {
					const late = events.filter((event) => !event.counted)
					const counted = (variant: Variant, kind: Kind) =>
						events.filter((event) => event.counted && event.variant === variant && event.kind === kind)
					const focused = focus === null || focus === 'late' ? late : counted(focus.variant, focus.kind)
					const outcome = focus !== null && focus !== 'late' ? OUTCOMES.find((o) => o.kind === focus.kind)! : null
					const companies = new Set(focused.map((event) => event.cardId)).size

					return (
						<>
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
								<div className="flex items-center gap-1">
									<h2 id="results-heading" className="font-semibold">
										Results
									</h2>
									{!ab && <span className="text-muted-foreground">· {nameOf('A')}</span>}
									<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												aria-label="How results are counted"
												className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
											>
												<Info className="size-3.5" />
											</button>
										</TooltipTrigger>
										<TooltipContent className="max-w-72">
											A reply, visit or meeting counts for a card when it comes from the same company or person within{' '}
											{ATTRIBUTION_WINDOW_DAYS} days after the card was mailed. Each card counts once per column,
											however many times that company replied or visited, so a rate is the share of cards sent.
										</TooltipContent>
									</Tooltip>
								</div>
								{late.length > 0 && (
									<button type="button" className="link ml-auto text-xs" onClick={() => setFocus('late')}>
										{plural(late.length, ['event', 'events'])} after the {ATTRIBUTION_WINDOW_DAYS}-day window (not
										counted)
									</button>
								)}
							</div>

							{variants.every((variant) => summary.byVariant[variant].sent === 0) ? (
								<p className="text-sm text-muted-foreground">
									Nothing sent yet. Results show here once the first postcard goes to the printer.
								</p>
							) : (
								<div className="overflow-x-auto">
									<table className="w-full min-w-[30rem] table-fixed border-separate border-spacing-0 text-left">
										<thead>
											<tr className="text-xs font-medium text-muted-foreground">
												{ab && (
													<th scope="col" className="w-24 pr-2 sm:w-32">
														<span className="sr-only">Template</span>
													</th>
												)}
												<th scope="col" className="px-2 font-medium">
													Sent
												</th>
												<th scope="col" className="px-2 font-medium">
													Delivered
												</th>
												{OUTCOMES.map((o, index) => (
													<th
														key={o.kind}
														scope="col"
														className={cn('px-2 font-medium', index === 0 && 'border-l pl-3')}
													>
														{o.label}
													</th>
												))}
											</tr>
										</thead>
										<tbody>
											{variants.map((variant) => {
												const value = summary.byVariant[variant]
												const tone = TONE[variant]
												const inTransit = value.sent - value.delivered - value.returned
												const forTemplate = ab ? ` with ${nameOf(variant)}` : ''
												return (
													<tr key={variant}>
														{ab && (
															<th scope="row" className="pr-2 text-left text-sm font-medium">
																<span className="flex items-center gap-2">
																	<span aria-hidden className={cn('size-2 shrink-0 rounded-full', tone.dot)} />
																	<span className="truncate" title={nameOf(variant)}>
																		{nameOf(variant)}
																	</span>
																</span>
															</th>
														)}
														<td className="p-0.5">
															<Stat
																headline={value.sent}
																bar={<Bar track={tone.track} left={[value.sent > 0 ? 1 : 0, tone.fill]} />}
																onClick={value.sent > 0 ? () => onShowCards('sent', variant) : undefined}
																tip={`${plural(value.sent, ['postcard', 'postcards'])} handed to the printer${forTemplate}.${value.sent > 0 ? ' Click to list them.' : ''}`}
															/>
														</td>
														<td className="p-0.5">
															<Stat
																headline={`${percent(value.delivered, value.sent)}%`}
																count={value.delivered}
																bar={
																	<Bar
																		track={tone.track}
																		left={[value.delivered / value.sent, tone.fill]}
																		right={[value.returned / value.sent, 'bg-destructive']}
																	/>
																}
																onClick={value.delivered > 0 ? () => onShowCards('delivered', variant) : undefined}
																tip={
																	<>
																		<dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
																			<dt>Delivered</dt>
																			<dd className="text-right">
																				{value.delivered} of {value.sent}
																			</dd>
																			<dt>Returned to sender</dt>
																			<dd className="text-right">{value.returned}</dd>
																			<dt>No delivery report yet</dt>
																			<dd className="text-right">{inTransit}</dd>
																		</dl>
																		{value.delivered > 0 && <p className="mt-1">Click to list the delivered cards.</p>}
																	</>
																}
															/>
														</td>
														{OUTCOMES.map((o, index) => {
															const count = value[o.count]
															const rate = value[o.rate] ?? '0'
															const total = counted(variant, o.kind).length
															return (
																<td key={o.kind} className={cn('p-0.5', index === 0 && 'border-l pl-1.5')}>
																	<Stat
																		headline={`${rate}%`}
																		count={count}
																		bar={<Bar track={tone.track} left={[Number(rate) / 100, tone.fill]} />}
																		onClick={count > 0 ? () => setFocus({ variant, kind: o.kind }) : undefined}
																		tip={
																			count > 0
																				? `${count} of ${plural(value.sent, ['card', 'cards'])}${forTemplate} ${o.outcome} within ${ATTRIBUTION_WINDOW_DAYS} days of mailing (${rate}%).${total > count ? ` ${plural(total, o.noun)} in all.` : ''} Click to see who.`
																				: `No card${forTemplate} ${o.outcome} within ${ATTRIBUTION_WINDOW_DAYS} days of mailing yet.`
																		}
																	/>
																</td>
															)
														})}
													</tr>
												)
											})}
										</tbody>
									</table>
								</div>
							)}

							{ab && summary.tooSmallToConclude && (
								<p className="text-xs text-muted-foreground">
									Sample too small to conclude: each template needs at least {MIN_SAMPLE_PER_VARIANT} cards sent.
								</p>
							)}

							<Sheet open={focus !== null} onOpenChange={(open) => !open && setFocus(null)}>
								<SheetContent className="w-full overflow-y-auto sm:max-w-md">
									{focus !== null && (
										<>
											<SheetHeader>
												<SheetTitle>
													{outcome
														? `${outcome.label} counted${ab && focus !== 'late' ? ` for ${nameOf(focus.variant)}` : ''}`
														: `After the ${ATTRIBUTION_WINDOW_DAYS}-day window`}
												</SheetTitle>
												<SheetDescription>
													{outcome
														? `${plural(focused.length, outcome.noun)} from ${plural(companies, ['company', 'companies'])} within ${ATTRIBUTION_WINDOW_DAYS} days after the card was mailed.`
														: `${plural(focused.length, ['event', 'events'])} matched a mailed card but came too late, so the results leave them out.`}
												</SheetDescription>
											</SheetHeader>
											<ul className="divide-y px-4 pb-4 text-sm">
												{focused.map((event) => (
													<li key={event.eventId} className="py-2">
														<p className="font-medium">
															{!outcome && `${KIND_LABEL[event.kind]} from `}
															<Link to={cardLink(event.cardId)} className="link" onClick={() => setFocus(null)}>
																{event.companyName ?? `card #${event.cardId}`}
															</Link>
														</p>
														<p className="text-muted-foreground">
															{formatDate(event.occurredAt)} · day {event.daysAfterMailing} after mailing
														</p>
													</li>
												))}
											</ul>
										</>
									)}
								</SheetContent>
							</Sheet>
						</>
					)
				}}
			</QueryState>
		</section>
	)
}

// One funnel cell: big number, count in brackets, a bar against cards sent, details on hover or focus.
function Stat({
	headline,
	count,
	bar,
	tip,
	onClick,
}: {
	headline: ReactNode
	count?: number
	bar: ReactNode
	tip: ReactNode
	onClick?: () => void
}) {
	const Trigger = onClick ? 'button' : 'span'
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Trigger
					type={onClick ? 'button' : undefined}
					tabIndex={onClick ? undefined : 0}
					onClick={onClick}
					className="block w-full rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
				>
					<span className="flex flex-wrap items-baseline gap-x-1 tabular-nums">
						{/* What a click acts on wears the link colour: the count, or the headline when it is the count. */}
						<span className={cn('text-base font-semibold', onClick && count === undefined && 'text-link')}>
							{headline}
						</span>
						{count !== undefined && (
							<span className={cn('text-xs', onClick ? 'text-link' : 'text-muted-foreground')}>({count})</span>
						)}
					</span>
					{bar}
				</Trigger>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-64">
				{tip}
			</TooltipContent>
		</Tooltip>
	)
}

// Share of cards sent. Delivered fills from the left, returned from the right; the gap between is still in the post.
function Bar({ track, left, right }: { track: string; left: [number, string]; right?: [number, string] }) {
	const segment = ([share, fill]: [number, string]) =>
		share > 0 && (
			// A non-zero share never shrinks out of sight.
			<span
				className={cn('h-full rounded-full', fill)}
				style={{ width: `${Math.min(share, 1) * 100}%`, minWidth: 4 }}
			/>
		)
	return (
		<span aria-hidden className={cn('mt-1.5 flex h-1.5 justify-between gap-0.5 overflow-hidden rounded-full', track)}>
			{segment(left)}
			{right && segment(right)}
		</span>
	)
}
