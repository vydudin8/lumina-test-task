import type { CampaignDetail } from '#client/domain/campaigns.ts'

// The campaign in one line: eligible and blocked cards with the reasons, the template split and rejected AI lines.
// Each count is a link that filters the list to those cards.
export function CardsSummary({
	detail,
	nameOf,
	onShow,
	onShowTemplate,
}: {
	detail: CampaignDetail
	nameOf: (templateId: number | null) => string | undefined
	onShow: (view: string) => void
	onShowTemplate: (variant: 'A' | 'B') => void
}) {
	const { campaign, summary } = detail
	const suppressed = Object.entries(summary.blocked)
		.filter(([reason]) => reason.startsWith('suppressed:'))
		.reduce((sum, [, n]) => sum + n, 0)
	const badAddress = Object.entries(summary.blocked)
		.filter(([reason]) => reason.startsWith('invalid_address:'))
		.reduce((sum, [, n]) => sum + n, 0)
	const noContact = summary.blocked['no_contact'] ?? 0

	return (
		<p className="text-sm">
			{summary.total} cards:{' '}
			<button type="button" className="link" onClick={() => onShow('all')}>
				{summary.eligible} eligible
			</button>
			,{' '}
			<button type="button" className="link" onClick={() => onShow('blocked')}>
				{summary.total - summary.eligible} blocked
			</button>{' '}
			({suppressed} suppressed, {badAddress} bad address{noContact > 0 && `, ${noContact} no contact`})
			{summary.blockedAtSend > 0 && ` · ${summary.blockedAtSend} blocked at send`} ·{' '}
			{campaign.templateBId === null ? (
				`${nameOf(campaign.templateAId) ?? 'one template'} on every card (no A/B test)`
			) : (
				<>
					<button type="button" className="link" onClick={() => onShowTemplate('A')}>
						{nameOf(campaign.templateAId) ?? 'Template A'} {summary.variants.A}
					</button>
					,{' '}
					<button type="button" className="link" onClick={() => onShowTemplate('B')}>
						{nameOf(campaign.templateBId) ?? 'Template B'} {summary.variants.B}
					</button>
				</>
			)}
			{summary.llmRejected > 0 && (
				<>
					{' · '}
					<button type="button" className="link" onClick={() => onShow('ai-rejected')}>
						{summary.llmRejected} AI lines rejected (template used)
					</button>
				</>
			)}
		</p>
	)
}
