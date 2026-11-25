import { type CampaignCard } from '#client/domain/campaigns.ts'
import { useUserName } from '#client/domain/session.ts'
import { formatAddress } from '#client/lib/format.ts'
import { PROVIDER_LABELS, type ProviderName } from '#common/settings.ts'
import { Link } from 'react-router'

const DECIDED_BY: Record<string, string> = {
	'only candidate': 'the only person listed at this company',
	function:
		'works in the most relevant function (operations, then fleet and plant, then procurement, then sustainability)',
	seniority: 'most senior in that function',
	corroboration: 'confirmed by more providers than the others',
	freshness: 'has the most recent record',
	'contact id': 'the earliest record (all else was equal)',
	'seeded history': 'from a past campaign',
}

// Who the card goes to and where: the address and its source, and why this person rather than a colleague.
export function CardRecipient({ card, company }: { card: CampaignCard; company: string }) {
	const userName = useUserName()
	return (
		<div className="sm:border-l sm:pl-3">
			{card.recipient ? (
				<>
					<p className="font-medium">{card.recipient.fullName}</p>
					<p>{card.recipient.title}</p>
				</>
			) : (
				<p className="text-muted-foreground">No contact on file</p>
			)}
			<p>{company}</p>
			<p className="text-muted-foreground">{formatAddress(card.address)}</p>
			{card.address && card.addressSource && (
				<p className="mt-1 text-xs text-muted-foreground">
					Address from {PROVIDER_LABELS[card.addressSource.provider as ProviderName] ?? card.addressSource.provider}
					{card.addressSource.chosenBy && `, chosen by ${userName(card.addressSource.chosenBy)}`} ·{' '}
					<Link to={`/companies/${card.companyId}#field-address`} className="link">
						see sources
					</Link>
				</p>
			)}
			{card.addressSource?.conflict && !card.addressSource.chosenBy && (
				<p className="mt-1 text-xs font-medium text-destructive">
					Providers disagree on this address: check it before approving.
				</p>
			)}
			{card.recipient ? (
				<details className="mt-2 text-xs">
					<summary className="cursor-pointer">Why this person</summary>
					<p className="mt-1">
						{card.recipient.fullName}: {DECIDED_BY[card.recipient.decidedBy] ?? card.recipient.decidedBy}. Known to{' '}
						{card.recipient.providers
							.map((provider) => PROVIDER_LABELS[provider as ProviderName] ?? provider)
							.join(' and ')}
						.
					</p>
					{card.recipient.candidates.length > 1 && (
						<ul className="mt-1 space-y-0.5 text-muted-foreground">
							{card.recipient.candidates.slice(1).map((candidate) => (
								<li key={candidate.personKey}>
									Not chosen: {candidate.fullName}, {candidate.title} ({candidate.function ?? 'other function'},{' '}
									{candidate.seniority.replace('_', ' ')})
								</li>
							))}
						</ul>
					)}
					{card.blockReason && <p className="mt-1">This card is blocked. We do not send it to someone else instead.</p>}
				</details>
			) : (
				<p className="mt-2 text-xs text-muted-foreground">
					No provider lists a person at this company, so there is nobody to address a card to. The company stays in the
					list so you can see it was skipped.
				</p>
			)}
		</div>
	)
}
