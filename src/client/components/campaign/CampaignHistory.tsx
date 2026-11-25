import { EventSheet, EventSummary } from '#client/components/ActivityTimeline.tsx'
import { FilterBar, FilterDateRange, FilterSelect } from '#client/components/Filters.tsx'
import { Pager } from '#client/components/Pager.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { Badge } from '#client/components/ui/badge.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#client/components/ui/sheet.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '#client/components/ui/tooltip.tsx'
import { actionLabel, type AuditEvent } from '#client/domain/audit.ts'
import type { CampaignDetail } from '#client/domain/campaigns.ts'
import { CARD_TONE, groupLabel, HISTORY_PARAMS } from '#client/domain/campaigns.ts'
import { roleLabel, useUserName } from '#client/domain/session.ts'
import { api } from '#client/lib/api.ts'
import { formatDateTime, formatInteger } from '#client/lib/format.ts'
import { dayStart, useCursorPages, useFilterParams } from '#client/lib/lists.ts'
import { CARD_STATUS_LABELS } from '#common/settings.ts'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronRight, History } from 'lucide-react'
import { useState } from 'react'

interface ActivityGroup {
	id: string
	action: string
	actorId: string
	actorRole: string
	at: string
	firstAt: string
	count: number
	cardIds: number[]
	events: AuditEvent[]
}

// What the sheet needs to name a card its entries are about; the campaign page itself holds only one page of cards.
interface HistoryCard {
	id: number
	rank: number
	companyId: number
	companyName: string | null
	status: string
	fullName: string | null
}

interface ActivityResponse {
	total: number
	pageSize: number
	nextCursor: string | null
	groups: ActivityGroup[]
	actions: string[]
	cards: HistoryCard[]
}

export function CampaignHistory({ campaign }: { campaign: CampaignDetail['campaign'] }) {
	const [params, update] = useFilterParams()
	const open = params.get('history') === '1'
	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button variant="outline" size="icon" aria-label="History" onClick={() => update({ history: '1' })}>
						<History />
					</Button>
				</TooltipTrigger>
				<TooltipContent>History</TooltipContent>
			</Tooltip>
			<Sheet open={open} onOpenChange={(next) => !next && update(HISTORY_PARAMS)}>
				<SheetContent className="w-full overflow-y-auto sm:max-w-xl">
					<SheetHeader>
						<SheetTitle>History</SheetTitle>
						<SheetDescription>What happened to this campaign and its cards, newest first.</SheetDescription>
					</SheetHeader>
					{open && <HistoryBody campaign={campaign} />}
				</SheetContent>
			</Sheet>
		</>
	)
}

function HistoryBody({ campaign }: { campaign: CampaignDetail['campaign'] }) {
	const [params, update] = useFilterParams()
	const userName = useUserName()
	const filters = new URLSearchParams()
	if (params.get('hAction')) filters.set('action', params.get('hAction')!)
	if (params.get('hCard')) filters.set('card', params.get('hCard')!)
	const range = { from: params.get('hFrom') ?? '', to: params.get('hTo') ?? '' }
	const from = dayStart(range.from)
	const to = dayStart(range.to, 1)
	if (from) filters.set('from', from)
	if (to) filters.set('to', to)
	const pages = useCursorPages(`campaign-history-${campaign.id}`, filters.toString())
	const search = new URLSearchParams(filters)
	if (pages.cursor) search.set('cursor', pages.cursor)
	const query = useQuery({
		// Under the campaign's key, so every refresh of the campaign refreshes its history too.
		queryKey: ['campaign', campaign.id, 'activity', search.toString()],
		queryFn: () => api<ActivityResponse>(`/api/campaigns/${campaign.id}/activity?${search.toString()}`),
		placeholderData: keepPreviousData,
	})

	return (
		<div className="space-y-5 px-4 pb-4 text-sm">
			<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 rounded-md border bg-muted/40 p-3">
				<dt className="text-muted-foreground">Created</dt>
				<dd>
					{formatDateTime(campaign.createdAt)} by {userName(campaign.createdBy)}
				</dd>
				{campaign.launchedAt && (
					<>
						<dt className="text-muted-foreground">Launched</dt>
						<dd>
							{formatDateTime(campaign.launchedAt)} by {userName(campaign.launchedBy ?? '')}
						</dd>
					</>
				)}
			</dl>

			<QueryState query={query}>
				{(data) => {
					const cardsById = new Map(data.cards.map((card) => [card.id, card]))
					return (
						<div className="space-y-4">
							<FilterBar
								active={['hAction', 'hCard', 'hFrom', 'hTo'].some((key) => params.has(key))}
								onClear={() => update({ hAction: '', hCard: '', hFrom: '', hTo: '' })}
								count={`${formatInteger(data.total)} ${data.total === 1 ? 'entry' : 'entries'}`}
							>
								<FilterSelect
									label="What"
									all="Everything"
									value={params.get('hAction') ?? ''}
									onChange={(value) => update({ hAction: value })}
									options={data.actions.map((action) => [action, actionLabel(action)])}
								/>
								<FilterSelect
									label="Card"
									all="Any card"
									value={params.get('hCard') ?? ''}
									onChange={(value) => update({ hCard: value })}
									options={data.cards.map((card) => [String(card.id), `#${card.rank} ${companyOf(card)}`])}
								/>
								<FilterDateRange
									label="When"
									value={range}
									onChange={(next) => update({ hFrom: next.from, hTo: next.to })}
								/>
							</FilterBar>

							{data.groups.length === 0 ? (
								<p className="text-muted-foreground">Nothing matches these filters.</p>
							) : (
								<ol className="divide-y rounded-md border">
									{data.groups.map((group) => (
										<HistoryEntry key={group.id} group={group} cardsById={cardsById} />
									))}
								</ol>
							)}
							<Pager
								page={pages.page}
								pageSize={data.pageSize}
								shown={data.groups.length}
								total={data.total}
								onFirst={pages.page > 0 ? pages.first : null}
								onPrevious={pages.page > 0 ? pages.previous : null}
								onNext={data.nextCursor ? () => pages.next(data.nextCursor!) : null}
							/>
							<EventSheet events={data.groups.flatMap((group) => group.events)} />
						</div>
					)
				}}
			</QueryState>
		</div>
	)
}

const companyOf = (card: HistoryCard) => card.companyName ?? `Company #${card.companyId}`

function HistoryEntry({ group, cardsById }: { group: ActivityGroup; cardsById: Map<number, HistoryCard> }) {
	const userName = useUserName()
	const [open, setOpen] = useState(false)
	const [event] = group.events
	const single = group.count === 1 ? cardsById.get(group.cardIds[0] ?? -1) : undefined

	return (
		<li className="space-y-1.5 p-3">
			<div className="flex items-start justify-between gap-3">
				<p className="font-medium">
					{groupLabel(group.action, group.count)}
					{single && (
						<span className="font-normal">
							{' '}
							· #{single.rank} {companyOf(single)}
						</span>
					)}
				</p>
				<time className="shrink-0 text-xs text-muted-foreground" dateTime={group.at}>
					{formatDateTime(group.at)}
				</time>
			</div>
			<p className="text-xs text-muted-foreground">
				{userName(group.actorId)} ({roleLabel(group.actorRole)})
			</p>
			{group.count === 1 && event ? (
				<>
					<EventSummary event={event} />
					{event.reason && <p className="text-muted-foreground">Reason: {event.reason}</p>}
				</>
			) : (
				<>
					<Button size="xs" variant="ghost" className="-ml-2" aria-expanded={open} onClick={() => setOpen(!open)}>
						<ChevronRight className={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
						{open ? 'Hide' : 'Show'} {group.cardIds.length > 0 ? `${group.cardIds.length} cards` : 'entries'}
					</Button>
					{open && (
						<ul className="space-y-1.5 border-l pl-3">
							{group.events.map((member) => {
								const card = cardsById.get(Number(member.entityId))
								return (
									<li key={member.id} className="space-y-0.5">
										<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
											<span>
												{card ? `#${card.rank} ${companyOf(card)}` : `${member.entityType} #${member.entityId}`}
											</span>
											{card?.fullName && <span className="text-muted-foreground">{card.fullName}</span>}
											{card && (
												<Badge variant={CARD_TONE[card.status] ?? 'secondary'}>
													Now: {CARD_STATUS_LABELS[card.status] ?? card.status}
												</Badge>
											)}
										</div>
										{member.reason && <p className="text-muted-foreground">Reason: {member.reason}</p>}
										<EventSummary event={member} />
									</li>
								)
							})}
						</ul>
					)}
				</>
			)}
		</li>
	)
}
