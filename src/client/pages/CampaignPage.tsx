import { CampaignHeader } from '#client/components/campaign/CampaignHeader.tsx'
import { CampaignResults } from '#client/components/campaign/CampaignResults.tsx'
import { CardItem } from '#client/components/campaign/CardItem.tsx'
import { CardScoreSheet } from '#client/components/campaign/CardScoreSheet.tsx'
import { CardsSummary } from '#client/components/campaign/CardsSummary.tsx'
import { CardsToolbar } from '#client/components/campaign/CardsToolbar.tsx'
import { SendControls } from '#client/components/campaign/SendControls.tsx'
import { FilterBar, FilterSelect } from '#client/components/Filters.tsx'
import { Pager } from '#client/components/Pager.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { SearchInput } from '#client/components/SearchInput.tsx'
import {
	CARD_VIEWS,
	cardHistoryParams,
	defaultExpanded,
	useResultsShown,
	type CampaignCard,
	type CampaignDetail,
} from '#client/domain/campaigns.ts'
import { useSession } from '#client/domain/session.ts'
import { api } from '#client/lib/api.ts'
import { useCursorPages, useEntryState, useFilterParams } from '#client/lib/lists.ts'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router'

// One page of a campaign's cards, with what each filter choice would show.
interface CardsResponse {
	total: number
	pageSize: number
	nextCursor: string | null
	counts: { views: Record<string, number>; variants: { A: number; B: number } }
	cards: CampaignCard[]
}

const isOverrides = (value: unknown): value is Record<string, boolean> =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	Object.values(value).every((open) => typeof open === 'boolean')

export function CampaignPage() {
	const id = Number(useParams().id)
	const query = useQuery({
		queryKey: ['campaign', id],
		queryFn: () => api<CampaignDetail>(`/api/campaigns/${id}`),
	})
	return <QueryState query={query}>{(detail) => <CampaignView detail={detail} />}</QueryState>
}

function CampaignView({ detail }: { detail: CampaignDetail }) {
	const { campaign, summary, linesJob } = detail
	const { data: user } = useSession()
	const queryClient = useQueryClient()
	const [params, update] = useFilterParams()
	const [viewName] = CARD_VIEWS.find(([value]) => value === params.get('show')) ?? CARD_VIEWS[0]!
	const isLead = user?.role === 'lead'
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['campaign', campaign.id] })
	const templateOf = (card: CampaignCard) =>
		detail.templates.find(
			(template) => template.id === (card.variant === 'B' ? campaign.templateBId : campaign.templateAId),
		)
	const nameOf = (templateId: number | null) => detail.templates.find((template) => template.id === templateId)?.name

	// Open or closed per card, kept per history entry: defaults until someone toggles a card.
	const [overrides, setOverrides] = useEntryState(`campaign-cards:${campaign.id}`, {}, isOverrides)
	const isOpen = (card: CampaignCard) => overrides[card.id] ?? defaultExpanded(card)
	const setOpen = (ids: number[], open: boolean) =>
		setOverrides({ ...overrides, ...Object.fromEntries(ids.map((id) => [id, open])) })

	const search = params.get('q') ?? ''
	const abTest = campaign.templateBId !== null
	const variant = abTest ? (['A', 'B'].find((value) => value === params.get('template')) ?? '') : ''
	// The server filters and pages; a change of filter starts again from the first page.
	const listKey = [viewName, search.trim(), variant].join('|')
	const pages = useCursorPages(`campaign-cards-${campaign.id}`, listKey)
	const filters = new URLSearchParams()
	if (search.trim()) filters.set('q', search.trim())
	if (viewName !== 'all') filters.set('show', viewName)
	if (variant) filters.set('template', variant)
	if (pages.cursor) filters.set('cursor', pages.cursor)
	// Under the campaign's key, so every notice about the campaign refreshes its cards too.
	const cardsQuery = useQuery({
		queryKey: ['campaign', campaign.id, 'cards', filters.toString()],
		queryFn: () => api<CardsResponse>(`/api/campaigns/${campaign.id}/cards?${filters.toString()}`),
		placeholderData: keepPreviousData,
	})
	const list = cardsQuery.data
	const visible = list?.cards ?? []
	const count = (value: number | undefined) => value ?? '…'

	// A selection belongs to the list it was made in, so changing a filter never acts on hidden cards.
	const [selection, setSelection] = useState<{ list: string; ids: number[] }>({ list: listKey, ids: [] })
	const selected = new Set(selection.list === listKey ? selection.ids : [])
	const select = (ids: number[]) => setSelection({ list: listKey, ids })

	const [resultsShown, toggleResults] = useResultsShown(user?.id ?? '', campaign.id, summary.sent > 0)

	// Arriving from a results link (#card-12): open the page that holds the card, then bring it into view; it flashes
	// once (row-flash in styles.css).
	const location = useLocation()
	const target = /^#card-(\d+)$/.exec(location.hash)?.[1]
	// Not under the campaign's key: where a card sits in the ranking never changes, so a notice need not ask again.
	const placement = useQuery({
		queryKey: ['card-page', campaign.id, target],
		queryFn: () => api<{ cursors: string[] }>(`/api/campaigns/${campaign.id}/cards/${target}/cursors`),
		enabled: target !== undefined,
	})
	useEffect(() => {
		if (placement.data) pages.to(placement.data.cursors)
		// Once per arrival: paging away afterwards must not snap back to the card.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [location.key, placement.data])
	const scrolled = useRef('')
	useEffect(() => {
		const card = target ? document.getElementById(`card-${target}`) : null
		if (!card || scrolled.current === `${location.key}${target}`) return
		scrolled.current = `${location.key}${target}`
		card.scrollIntoView({ block: 'center' })
	}, [location.key, target, list])
	const explaining = visible.find((card) => String(card.id) === params.get('card'))

	const show = (value: string) => update({ show: value === 'all' ? '' : value })
	// Only the template filter, so the list shows exactly the count the link names.
	const showTemplate = (value: 'A' | 'B') => update({ template: value, show: '', q: '' })

	return (
		<div className="space-y-6">
			<CampaignHeader detail={detail} resultsShown={resultsShown} onToggleResults={toggleResults} />

			{summary.linesPending > 0 && (
				<p role="status" className="rounded-lg border bg-muted/50 p-3 text-sm">
					{linesJob?.status === 'failed' ? (
						<span className="text-destructive">
							Writing the personal lines stopped: {linesJob.error ?? 'no reason recorded'}. {summary.linesPending} cards
							have no line yet; write one by hand to approve them.
						</span>
					) : (
						<>
							Writing personal lines: {summary.eligible - summary.linesPending} of {summary.eligible}. Cards can be
							approved as their lines appear.
						</>
					)}
				</p>
			)}

			{resultsShown && (
				<CampaignResults
					campaignId={campaign.id}
					templateNames={{
						A: nameOf(campaign.templateAId) ?? 'Template A',
						B: campaign.templateBId === null ? undefined : (nameOf(campaign.templateBId) ?? 'Template B'),
					}}
					// No filters, so the card is in the list; the hash brings it into view and makes it flash.
					cardLink={(cardId) => ({ search: '', hash: `card-${cardId}` })}
					// Only these filters, so the list shows exactly the count that was clicked.
					onShowCards={(view, cardVariant) => update({ show: view, template: abTest ? cardVariant : '', q: '' })}
				/>
			)}

			<div>
				<CardsSummary detail={detail} nameOf={nameOf} onShow={show} onShowTemplate={showTemplate} />

				<div className="mt-4 mb-3 flex flex-wrap items-center gap-2">
					<div className="min-w-0 flex-1">
						<FilterBar
							active={search !== '' || variant !== '' || viewName !== 'all'}
							onClear={() => update({ q: '', template: '', show: '' })}
						>
							<SearchInput
								aria-label="Search cards"
								placeholder="Search company name"
								className="w-full sm:w-72"
								value={search}
								onChange={(value) => update({ q: value }, { replace: true })}
							/>
							<FilterSelect
								label="Status"
								all={`All cards (${count(list?.counts.views.all)})`}
								value={viewName === 'all' ? '' : viewName}
								onChange={show}
								options={CARD_VIEWS.slice(1).map(
									([value, label]) => [value, `${label} (${count(list?.counts.views[value])})`] as const,
								)}
							/>
							{abTest && (
								<FilterSelect
									label="Template"
									all="All templates"
									value={variant}
									onChange={(value) => update({ template: value })}
									options={[
										['A', `${nameOf(campaign.templateAId) ?? 'Template A'} (${count(list?.counts.variants.A)})`],
										['B', `${nameOf(campaign.templateBId) ?? 'Template B'} (${count(list?.counts.variants.B)})`],
									]}
								/>
							)}
						</FilterBar>
					</div>
					<SendControls campaignId={campaign.id} summary={summary} isLead={isLead} onChange={refresh} />
				</div>

				<section aria-label="Cards" className="space-y-2">
					<CardsToolbar
						campaignId={campaign.id}
						visible={visible}
						total={list?.total}
						viewName={viewName}
						selected={selected}
						onSelect={select}
						isOpen={isOpen}
						onSetOpen={setOpen}
						isLead={isLead}
						onChange={refresh}
					/>

					{visible.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{cardsQuery.isError
								? `Could not load the cards: ${cardsQuery.error.message}`
								: !list
									? 'Loading…'
									: search
										? `No card matches “${search}”.`
										: 'No cards here.'}
						</p>
					) : (
						<div className="divide-y rounded-lg border bg-card">
							{visible.map((card) => (
								<CardItem
									key={card.id}
									card={card}
									template={templateOf(card)}
									isLead={isLead}
									open={isOpen(card)}
									onToggle={() => setOpen([card.id], !isOpen(card))}
									selected={selected.has(card.id)}
									onSelect={(on) => select(on ? [...selected, card.id] : [...selected].filter((id) => id !== card.id))}
									onExplainScore={() => update({ card: String(card.id) })}
									onShowHistory={() => update(cardHistoryParams(card.id))}
									onChange={refresh}
									flash={String(card.id) === target}
								/>
							))}
						</div>
					)}
					{list && (
						<Pager
							page={pages.page}
							pageSize={list.pageSize}
							shown={visible.length}
							total={list.total}
							onFirst={pages.page > 0 ? pages.first : null}
							onPrevious={pages.page > 0 ? pages.previous : null}
							onNext={list.nextCursor ? () => pages.next(list.nextCursor!) : null}
						/>
					)}
				</section>
			</div>

			<CardScoreSheet card={explaining} campaign={campaign} onClose={() => update({ card: '' })} />
		</div>
	)
}
