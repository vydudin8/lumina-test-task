import { CardRecipient } from '#client/components/campaign/CardRecipient.tsx'
import { LogOutcome } from '#client/components/campaign/LogOutcome.tsx'
import { PostcardText } from '#client/components/campaign/PostcardText.tsx'
import { SendTrail } from '#client/components/campaign/SendTrail.tsx'
import { UnconfirmedNotice } from '#client/components/campaign/UnconfirmedNotice.tsx'
import { ReasonDialog } from '#client/components/ReasonDialog.tsx'
import { Badge } from '#client/components/ui/badge.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Checkbox } from '#client/components/ui/checkbox.tsx'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '#client/components/ui/dialog.tsx'
import { Label } from '#client/components/ui/label.tsx'
import { Textarea } from '#client/components/ui/textarea.tsx'
import { toast } from '#client/components/ui/toast.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '#client/components/ui/tooltip.tsx'
import { CARD_TONE, companyOf, type CampaignCard, type Template } from '#client/domain/campaigns.ts'
import { rejectionSummary } from '#client/domain/llm.ts'
import { api } from '#client/lib/api.ts'
import { cn } from '#client/lib/utils.ts'
import { BLOCK_REASON_LABELS, CARD_STATUS_LABELS } from '#common/settings.ts'
import { useMutation } from '@tanstack/react-query'
import { ChevronRight, History } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

// Quiet on purpose: a fixed-width slot at the row's end so scores line up, and a click opens the breakdown.
// The slot is fixed, not the button, so the hover background hugs the text evenly.
function ScoreButton({ score, onClick }: { score: number; onClick: () => void }) {
	return (
		<div className="flex w-20 shrink-0 justify-end">
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label={`Score ${score}: see how it adds up`}
						onClick={onClick}
						className="cursor-pointer rounded-md px-1.5 py-1 text-xs text-muted-foreground tabular-nums transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					>
						Score <span className="font-semibold text-foreground">{score}</span>
					</button>
				</TooltipTrigger>
				<TooltipContent>How this score adds up</TooltipContent>
			</Tooltip>
		</div>
	)
}

// One line per card (who, which template, where it stands); the postcard and its evidence open below it.
export function CardItem({
	card,
	template,
	isLead,
	open,
	onToggle,
	selected,
	onSelect,
	onExplainScore,
	onShowHistory,
	onChange,
	flash,
}: {
	card: CampaignCard
	template?: Template
	isLead: boolean
	open: boolean
	onToggle: () => void
	selected: boolean
	onSelect: (selected: boolean) => void
	onExplainScore: () => void
	onShowHistory: () => void
	onChange: () => Promise<void>
	flash: boolean
}) {
	const [rejecting, setRejecting] = useState(false)
	const [editing, setEditing] = useState(false)
	const [text, setText] = useState(card.personalLine ?? '')
	// The line may have arrived since this card first rendered.
	const startEditing = () => {
		setText(card.personalLine ?? '')
		setEditing(true)
	}
	const company = companyOf(card)
	const approve = useMutation({
		mutationFn: () => api(`/api/cards/${card.id}/approve`, { method: 'POST' }),
		onSuccess: () => toast({ title: 'Card approved', description: company }),
		onError: (error) => toast({ tone: 'error', title: 'Could not approve', description: error.message }),
		onSettled: onChange,
	})
	const saveLine = useMutation({
		mutationFn: () => api(`/api/cards/${card.id}/line`, { method: 'POST', json: { text } }),
		onSuccess: async () => {
			setEditing(false)
			toast({
				title: 'Line saved',
				description: card.status === 'approved' ? `${company} is back in review.` : company,
			})
			await onChange()
		},
	})
	const editable = card.status === 'draft' || card.status === 'approved'
	const reason = card.blockReason && (BLOCK_REASON_LABELS[card.blockReason] ?? card.blockReason)
	const who = card.recipient
		? [card.recipient.fullName, card.recipient.title].filter(Boolean).join(', ')
		: 'No contact on file'

	return (
		<article
			id={`card-${card.id}`}
			aria-label={`Card for ${company}`}
			className={cn(selected && 'bg-primary/5', flash && 'animate-[row-flash_1.4s_ease-out]')}
		>
			<div className="flex items-center gap-2 py-2 pr-3 pl-3 sm:gap-3">
				<Checkbox aria-label={`Select ${company}`} checked={selected} onCheckedChange={(on) => onSelect(on === true)} />
				<Button
					variant="ghost"
					size="icon-sm"
					aria-expanded={open}
					aria-label={`${open ? 'Collapse' : 'Expand'} ${company}`}
					onClick={onToggle}
				>
					<ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
				</Button>
				<span className="w-8 shrink-0 text-sm text-muted-foreground tabular-nums">#{card.rank}</span>
				{/* The whole line toggles for a mouse; keyboard users have the chevron button. */}
				<div className="min-w-0 flex-1 cursor-pointer" onClick={onToggle}>
					<p className="truncate font-medium">
						<Link to={`/companies/${card.companyId}`} className="link" onClick={(event) => event.stopPropagation()}>
							{company}
						</Link>
					</p>
					<p className="truncate text-xs text-muted-foreground">
						{reason && <span className="font-medium text-destructive">{reason} · </span>}
						{who}
						{template && ` · ${template.name}`}
					</p>
					<Badge variant={CARD_TONE[card.status] ?? 'secondary'} className="mt-1 sm:hidden">
						{card.status === 'draft' ? 'Needs review' : (CARD_STATUS_LABELS[card.status] ?? card.status)}
					</Badge>
				</div>
				<Badge variant={CARD_TONE[card.status] ?? 'secondary'} className="hidden shrink-0 sm:inline-flex">
					{card.status === 'draft' ? 'Needs review' : (CARD_STATUS_LABELS[card.status] ?? card.status)}
				</Badge>
				<ScoreButton score={card.scoreDisplay} onClick={onExplainScore} />
			</div>

			{open && (
				<div className="space-y-3 border-t border-dashed px-4 py-3 sm:pl-24">
					<div className="grid gap-3 rounded-md bg-muted/50 p-3 text-sm sm:grid-cols-2">
						<div className="whitespace-pre-line">
							{template ? (
								<PostcardText
									body={template.body}
									card={card}
									company={company}
									onEdit={editable ? startEditing : undefined}
								/>
							) : (
								<span className="text-muted-foreground">Not printed.</span>
							)}
						</div>
						<CardRecipient card={card} company={company} />
					</div>

					<div className="space-y-1 text-xs">
						{card.lineSource === 'human' ? (
							<Badge variant="outline">Manually edited line</Badge>
						) : card.llmStatus === 'accepted' ? (
							<Badge variant="secondary">AI line, checked against the evidence</Badge>
						) : card.llmStatus === 'rejected' ? (
							<Badge variant="destructive">
								AI line rejected: {rejectionSummary(card.llmRejections)}. Template used.
							</Badge>
						) : null}
						{card.eligibility === 'blocked' && (
							<p className="text-muted-foreground">No line was written: this card is blocked.</p>
						)}
						{card.eligibility === 'eligible' && card.lineCites.length > 0 && (
							<p className="text-muted-foreground">
								Line uses:{' '}
								{card.lineCites
									.map((cite) => card.lineEvidence.find((item) => item.id === cite))
									.filter(Boolean)
									.map((item) => `${item!.label} (${item!.source})`)
									.join(', ')}
							</p>
						)}
						{card.rejectReason && <p>Rejected: {card.rejectReason}</p>}
						<SendTrail card={card} />
						{card.status === 'failed' && card.sendError && (
							<p className="text-destructive">
								Not sent: the printer refused it ({card.sendError}). A person needs to decide what to do with this card.
							</p>
						)}
						{card.status === 'unconfirmed' && <UnconfirmedNotice card={card} isLead={isLead} onChange={onChange} />}
					</div>

					<div className="flex flex-wrap gap-2">
						{card.mailedAt && <LogOutcome cardId={card.id} mailedAt={card.mailedAt} onLogged={onChange} />}
						{editable && (
							<>
								{isLead && card.status === 'draft' && (
									<Button
										size="sm"
										disabled={approve.isPending || card.personalLine === null}
										title={card.personalLine === null ? 'The personal line is still being written' : undefined}
										onClick={() => approve.mutate()}
									>
										Approve
									</Button>
								)}
								<Button size="sm" variant="outline" onClick={startEditing}>
									{card.personalLine === null ? 'Write line' : 'Edit line'}
								</Button>
								{card.status === 'draft' && (
									<Button size="sm" variant="outline" onClick={() => setRejecting(true)}>
										Reject
									</Button>
								)}
							</>
						)}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="outline"
									size="icon-sm"
									className="ml-auto"
									aria-label={`History of ${company}`}
									onClick={onShowHistory}
								>
									<History />
								</Button>
							</TooltipTrigger>
							<TooltipContent>History of this card</TooltipContent>
						</Tooltip>
					</div>
				</div>
			)}

			<ReasonDialog
				open={rejecting}
				onOpenChange={setRejecting}
				title="Reject this card"
				description={`${card.recipient?.fullName ?? 'Nobody'} at ${company} will not get a postcard from this campaign.`}
				confirmLabel="Reject"
				onConfirm={async (reason) => {
					await api(`/api/cards/${card.id}/reject`, { method: 'POST', json: { reason } })
					toast({ title: 'Card rejected', description: company })
					await onChange()
				}}
			/>
			<Dialog open={editing} onOpenChange={setEditing}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Edit the personal line</DialogTitle>
						<DialogDescription>
							{card.status === 'approved'
								? 'This card is approved. Saving a new line sends it back to draft for approval.'
								: 'Up to 200 characters, no contact details.'}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-1">
						<Label htmlFor={`line-${card.id}`}>Line ({text.trim().length}/200)</Label>
						<Textarea id={`line-${card.id}`} value={text} onChange={(event) => setText(event.target.value)} />
					</div>
					{saveLine.isError && <p className="text-sm text-destructive">{saveLine.error.message}</p>}
					<DialogFooter>
						<Button variant="outline" onClick={() => setEditing(false)}>
							Cancel
						</Button>
						<Button disabled={saveLine.isPending || text.trim() === ''} onClick={() => saveLine.mutate()}>
							Save line
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</article>
	)
}
