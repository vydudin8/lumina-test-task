import { Tooltip, TooltipContent, TooltipTrigger } from '#client/components/ui/tooltip.tsx'
import { type CampaignCard } from '#client/domain/campaigns.ts'
import { useUserName } from '#client/domain/session.ts'
import { formatDateTime, formatTime } from '#client/lib/format.ts'
import { CARD_STATUS_LABELS } from '#common/settings.ts'
import { Fragment } from 'react'

const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString()

// Where an approved card has got to, in one quiet line; a step on the same day as the one before shows only its time.
export function SendTrail({ card }: { card: CampaignCard }) {
	const userName = useUserName()
	const steps: { label: string; at: string; hint?: string }[] = []
	if (card.approvedAt)
		steps.push({
			label: card.approvedBy ? `Approved by ${userName(card.approvedBy)}` : 'Approved',
			at: card.approvedAt,
		})
	if (card.submittedAt) {
		const retries = card.attempts.length - 1
		steps.push({
			label: `Sent to the printer${retries > 0 ? ` after ${retries} ${retries === 1 ? 'retry' : 'retries'}` : ''}`,
			at: card.submittedAt,
			hint: card.mailId ? `Printer's reference: ${card.mailId}` : undefined,
		})
	}
	if (card.status === 'printed') steps.push({ label: 'Printed', at: card.statusChangedAt })
	if (card.mailedAt) steps.push({ label: 'Mailed', at: card.mailedAt })
	if (card.status === 'delivered' || card.status === 'returned')
		steps.push({ label: CARD_STATUS_LABELS[card.status] ?? card.status, at: card.statusChangedAt })
	if (steps.length === 0) return null

	return (
		<p className="text-muted-foreground">
			{steps.map((step, index) => {
				const previous = steps[index - 1]
				const text = `${step.label} ${previous && sameDay(step.at, previous.at) ? `at ${formatTime(step.at)}` : `on ${formatDateTime(step.at)}`}`
				return (
					<Fragment key={step.label}>
						{index > 0 && ' · '}
						{step.hint ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<span tabIndex={0} className="underline decoration-dotted underline-offset-2">
										{text}
									</span>
								</TooltipTrigger>
								<TooltipContent>{step.hint}</TooltipContent>
							</Tooltip>
						) : (
							text
						)}
					</Fragment>
				)
			})}
		</p>
	)
}
