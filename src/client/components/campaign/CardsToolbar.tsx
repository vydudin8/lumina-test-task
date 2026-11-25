import { ReasonDialog } from '#client/components/ReasonDialog.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Checkbox } from '#client/components/ui/checkbox.tsx'
import { toast } from '#client/components/ui/toast.tsx'
import type { CampaignCard } from '#client/domain/campaigns.ts'
import { api } from '#client/lib/api.ts'
import { useMutation } from '@tanstack/react-query'
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { useState } from 'react'

// Sticky above the cards on this page: select them (or just the ones to review), approve or reject the selection,
// expand or collapse.
export function CardsToolbar({
	campaignId,
	visible,
	total,
	viewName,
	selected,
	onSelect,
	isOpen,
	onSetOpen,
	isLead,
	onChange,
}: {
	campaignId: number
	visible: CampaignCard[]
	// All the cards the filters match, across pages; undefined while loading.
	total: number | undefined
	viewName: string
	selected: Set<number>
	onSelect: (ids: number[]) => void
	isOpen: (card: CampaignCard) => boolean
	onSetOpen: (ids: number[], open: boolean) => void
	isLead: boolean
	onChange: () => Promise<void>
}) {
	const [rejecting, setRejecting] = useState(false)
	const chosen = visible.filter((card) => selected.has(card.id))
	const drafts = chosen.filter((card) => card.status === 'draft')
	// A card without its line yet can be rejected but not approved.
	const approvable = drafts.filter((card) => card.personalLine !== null)
	const draftsInView = visible.filter((card) => card.status === 'draft')
	const targets = chosen.length > 0 ? chosen : visible
	// One bulk toggle: collapse only when every target is open, otherwise (all closed or mixed) expand.
	const allOpen = targets.length > 0 && targets.every(isOpen)

	const approve = useMutation({
		mutationFn: (cardIds: number[]) =>
			api<{ approved: number }>(`/api/campaigns/${campaignId}/approve`, { method: 'POST', json: { cardIds } }),
		onSuccess: ({ approved }) => {
			onSelect([])
			toast({ title: approved === 1 ? 'Card approved' : `${approved} cards approved` })
		},
		onError: (error) => toast({ tone: 'error', title: 'Could not approve', description: error.message }),
		onSettled: onChange,
	})

	return (
		<>
			<div className="sticky top-0 sm:top-14 z-10 -mx-1 flex flex-wrap items-center gap-2 rounded-md border bg-card/95 px-3 py-2 backdrop-blur">
				<Checkbox
					aria-label="Select every card on this page"
					disabled={visible.length === 0}
					checked={
						visible.length > 0 && chosen.length === visible.length ? true : chosen.length > 0 ? 'indeterminate' : false
					}
					onCheckedChange={(checked) => onSelect(checked === true ? visible.map((card) => card.id) : [])}
				/>
				<span className="text-sm text-muted-foreground tabular-nums">
					{chosen.length > 0 ? `${chosen.length} of ${visible.length} selected` : `${total ?? '…'} cards`}
				</span>
				{viewName !== 'review' && draftsInView.length > 0 && chosen.length === 0 && (
					<Button size="sm" variant="ghost" onClick={() => onSelect(draftsInView.map((card) => card.id))}>
						Select the {draftsInView.length} to review
					</Button>
				)}
				{chosen.length > 0 && (
					<>
						{isLead && (
							<Button
								size="sm"
								disabled={approvable.length === 0 || approve.isPending}
								onClick={() => approve.mutate(approvable.map((card) => card.id))}
							>
								Approve {approvable.length}
							</Button>
						)}
						<Button size="sm" variant="outline" disabled={drafts.length === 0} onClick={() => setRejecting(true)}>
							Reject {drafts.length}
						</Button>
						<Button size="sm" variant="ghost" onClick={() => onSelect([])}>
							Clear selection
						</Button>
					</>
				)}
				<span className="flex-1" />
				<Button
					size="sm"
					variant="ghost"
					disabled={visible.length === 0}
					onClick={() =>
						onSetOpen(
							targets.map((card) => card.id),
							!allOpen,
						)
					}
				>
					{allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
					<span className="sr-only sm:not-sr-only">
						{allOpen ? 'Collapse' : 'Expand'} {chosen.length > 0 ? 'selected' : 'all'}
					</span>
				</Button>
			</div>

			<ReasonDialog
				open={rejecting}
				onOpenChange={setRejecting}
				title={`Reject ${drafts.length} ${drafts.length === 1 ? 'card' : 'cards'}`}
				description="These people will not get a postcard from this campaign. The reason is saved with each card."
				confirmLabel={`Reject ${drafts.length}`}
				onConfirm={async (reason) => {
					await api(`/api/campaigns/${campaignId}/reject`, {
						method: 'POST',
						json: { cardIds: drafts.map((card) => card.id), reason },
					})
					toast({ title: drafts.length === 1 ? 'Card rejected' : `${drafts.length} cards rejected` })
					onSelect([])
					await onChange()
				}}
			/>
		</>
	)
}
