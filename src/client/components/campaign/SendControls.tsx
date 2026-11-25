import { Button } from '#client/components/ui/button.tsx'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '#client/components/ui/dialog.tsx'
import { toast } from '#client/components/ui/toast.tsx'
import type { CampaignSummary } from '#client/domain/campaigns.ts'
import { api } from '#client/lib/api.ts'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'

// The lead's send buttons: every approved card after a confirmation, and the unconfirmed ones again with the same
// requests. Anyone else sees why they have none.
export function SendControls({
	campaignId,
	summary,
	isLead,
	onChange,
}: {
	campaignId: number
	summary: CampaignSummary
	isLead: boolean
	onChange: () => Promise<void>
}) {
	const ready = summary.ready
	const unconfirmed = summary.byStatus.unconfirmed ?? 0
	const [confirmingSend, setConfirmingSend] = useState(false)
	const send = useMutation({
		mutationFn: () => api<{ queued: number }>(`/api/campaigns/${campaignId}/send`, { method: 'POST' }),
		onSuccess: ({ queued }) => {
			setConfirmingSend(false)
			toast({
				title: `Sending ${queued} ${queued === 1 ? 'postcard' : 'postcards'}`,
				description: 'Each card shows its status as the printer reports it.',
			})
		},
		onSettled: onChange,
	})
	const retryAll = useMutation({
		mutationFn: () => api<{ requeued: number }>(`/api/campaigns/${campaignId}/retry-unconfirmed`, { method: 'POST' }),
		onSuccess: ({ requeued }) =>
			toast({
				title: requeued === 1 ? 'Sent 1 card again' : `Sent ${requeued} cards again`,
				description: 'Same requests as before, so the printer cannot make a second card.',
			}),
		onError: (error) => toast({ tone: 'error', title: 'Could not send again', description: error.message }),
		onSettled: onChange,
	})

	if (!isLead) return <p className="text-sm text-muted-foreground">Only a sales lead can approve cards and send.</p>

	return (
		<>
			{unconfirmed > 0 && (
				<Button variant="outline" disabled={retryAll.isPending} onClick={() => retryAll.mutate()}>
					Try {unconfirmed} unconfirmed again
				</Button>
			)}
			<Button disabled={ready === 0} onClick={() => setConfirmingSend(true)}>
				Send {ready} approved
			</Button>
			<Dialog open={confirmingSend} onOpenChange={setConfirmingSend}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Send {ready} postcards?</DialogTitle>
						<DialogDescription>
							They go to the printer now. Each card is checked again for opt-outs and recent mailings just before it is
							sent, and is blocked rather than sent if anything changed. This cannot be undone.
						</DialogDescription>
					</DialogHeader>
					{send.isError && <p className="text-sm text-destructive">{send.error.message}</p>}
					<DialogFooter>
						<Button variant="outline" onClick={() => setConfirmingSend(false)}>
							Cancel
						</Button>
						<Button disabled={send.isPending} onClick={() => send.mutate()}>
							{send.isPending ? 'Queuing…' : `Send ${ready}`}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	)
}
