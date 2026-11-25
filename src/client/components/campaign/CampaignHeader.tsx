import { CampaignHistory } from '#client/components/campaign/CampaignHistory.tsx'
import { Badge } from '#client/components/ui/badge.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '#client/components/ui/tooltip.tsx'
import { campaignStage, type CampaignDetail } from '#client/domain/campaigns.ts'
import { useUserName } from '#client/domain/session.ts'
import { formatDateTime } from '#client/lib/format.ts'
import { Eye, EyeOff } from 'lucide-react'

// The campaign's name and where it stands, who built it, and the switches for its results and history.
export function CampaignHeader({
	detail,
	resultsShown,
	onToggleResults,
}: {
	detail: CampaignDetail
	resultsShown: boolean
	onToggleResults: () => void
}) {
	const { campaign, summary } = detail
	const userName = useUserName()
	const stage = campaignStage(summary)
	return (
		<div className="flex items-start justify-between gap-4">
			<div className="min-w-0 space-y-1">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
					<Badge variant={stage.tone} className="px-2.5 py-1 text-sm">
						{stage.label}
					</Badge>
					{stage.note && <span className="text-sm text-muted-foreground">{stage.note}</span>}
				</div>
				<p className="text-sm text-muted-foreground">
					Top {campaign.topN} by score with ICP version {campaign.icpVersionId} · built by{' '}
					{userName(campaign.createdBy)} on {formatDateTime(campaign.createdAt)}
				</p>
			</div>
			<div className="flex shrink-0 gap-2">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="outline"
							size="icon"
							aria-label={resultsShown ? 'Hide results' : 'Show results'}
							onClick={onToggleResults}
						>
							{resultsShown ? <EyeOff /> : <Eye />}
						</Button>
					</TooltipTrigger>
					<TooltipContent>{resultsShown ? 'Hide results' : 'Show results'}</TooltipContent>
				</Tooltip>
				<CampaignHistory campaign={campaign} />
			</div>
		</div>
	)
}
