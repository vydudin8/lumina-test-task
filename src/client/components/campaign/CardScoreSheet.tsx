import { ScoreBreakdown } from '#client/components/ScoreBreakdown.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#client/components/ui/sheet.tsx'
import { companyOf, type CampaignCard, type CampaignDetail } from '#client/domain/campaigns.ts'
import { formatDateTime, formatDecimal } from '#client/lib/format.ts'
import { Link } from 'react-router'

// The score as this campaign saw it when it was built (`?card=<id>`), so Back closes it like on the Scores page.
export function CardScoreSheet({
	card,
	campaign,
	onClose,
}: {
	card: CampaignCard | undefined
	campaign: CampaignDetail['campaign']
	onClose: () => void
}) {
	const earned = card?.contributions.reduce((sum, c) => sum + c.earned, 0) ?? 0
	const available = card?.contributions.reduce((sum, c) => sum + c.points, 0) ?? 0
	return (
		<Sheet open={card !== undefined} onOpenChange={(open) => !open && onClose()}>
			<SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
				{card && (
					<>
						<SheetHeader>
							<SheetTitle>
								<Link to={`/companies/${card.companyId}`} className="link">
									{companyOf(card)}
								</Link>
							</SheetTitle>
							<SheetDescription>
								Rank {card.rank} in this campaign, score {card.scoreDisplay}
								{available > 0 && (
									<>
										{' '}
										· {earned} of {available} points ={' '}
										<span title={formatDecimal(card.score) === card.score ? undefined : card.score}>
											{formatDecimal(card.score)}
										</span>
									</>
								)}
							</SheetDescription>
						</SheetHeader>
						<div className="space-y-4 px-4 pb-4">
							{card.contributions.length > 0 ? (
								<ScoreBreakdown companyId={card.companyId} contributions={card.contributions} />
							) : (
								<p className="text-sm text-muted-foreground">
									This card comes from a past campaign, so its rule-by-rule breakdown was not saved.
								</p>
							)}
							<p className="text-xs text-muted-foreground">
								Scored with ICP version {campaign.icpVersionId} when the campaign was built on{' '}
								{formatDateTime(campaign.createdAt)}. Company data may have changed since.{' '}
								<Link to={`/scores?company=${card.companyId}&version=${campaign.icpVersionId}`} className="link">
									See the current score and its AI explanation
								</Link>
							</p>
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	)
}
