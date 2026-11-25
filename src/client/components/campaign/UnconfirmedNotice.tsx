import { Button } from '#client/components/ui/button.tsx'
import { toast } from '#client/components/ui/toast.tsx'
import { type CampaignCard } from '#client/domain/campaigns.ts'
import { api } from '#client/lib/api.ts'
import { useMutation } from '@tanstack/react-query'

export function UnconfirmedNotice({
	card,
	isLead,
	onChange,
}: {
	card: CampaignCard
	isLead: boolean
	onChange: () => Promise<void>
}) {
	const retry = useMutation({
		mutationFn: () => api(`/api/cards/${card.id}/retry`, { method: 'POST' }),
		onSuccess: () =>
			toast({ title: 'Sent again', description: 'Same request as before, so the printer cannot make a second card.' }),
		onError: (error) => toast({ tone: 'error', title: 'Could not send again', description: error.message }),
		onSettled: onChange,
	})
	return (
		<div className="space-y-1">
			<p className="text-destructive">
				The printer did not answer after {card.attempts.length} attempts, so we do not know whether it received this
				card. Until we know, this person is held back as if mailed.
			</p>
			{isLead && (
				<Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>
					Try again with the same request
				</Button>
			)}
		</div>
	)
}
