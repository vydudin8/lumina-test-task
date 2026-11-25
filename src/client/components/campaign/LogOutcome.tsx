import { Button } from '#client/components/ui/button.tsx'
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
import { api } from '#client/lib/api.ts'
import { formatDate } from '#client/lib/format.ts'
import { dayOf, outcomeTime } from '#client/lib/lists.ts'
import { cn } from '#client/lib/utils.ts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

export function LogOutcome({
	cardId,
	mailedAt,
	onLogged,
}: {
	cardId: number
	mailedAt: string
	onLogged: () => Promise<void>
}) {
	const queryClient = useQueryClient()
	const [kind, setKind] = useState<'reply' | 'meeting' | null>(null)
	// Days in the browser's time zone: from the mailing day, since nothing earlier counts, to today.
	const [date, setDate] = useState(() => dayOf(new Date()))
	const firstDay = dayOf(new Date(mailedAt))
	const today = dayOf(new Date())
	const dateOk = date >= firstDay && date <= today
	const [note, setNote] = useState('')
	// One key per dialog opening, so a double click logs one outcome.
	const [key, setKey] = useState(() => crypto.randomUUID())
	const log = useMutation({
		mutationFn: () =>
			api(`/api/cards/${cardId}/outcomes`, {
				method: 'POST',
				headers: { 'Idempotency-Key': key },
				json: { kind, occurredAt: outcomeTime(date, mailedAt), note },
			}),
		onSuccess: async () => {
			toast({ title: kind === 'meeting' ? 'Meeting logged' : 'Reply logged' })
			setKind(null)
			setKey(crypto.randomUUID())
			setNote('')
			await queryClient.invalidateQueries({ queryKey: ['results'] })
			await onLogged()
		},
	})

	return (
		<>
			<div className="flex gap-2">
				<Button size="sm" variant="outline" onClick={() => setKind('reply')}>
					Log reply
				</Button>
				<Button size="sm" variant="outline" onClick={() => setKind('meeting')}>
					Log meeting
				</Button>
			</div>
			<Dialog open={kind !== null} onOpenChange={(open) => !open && setKind(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Log a {kind}</DialogTitle>
						<DialogDescription>
							It counts for this card only if it happened within 30 days after the card was mailed.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-1">
						<Label htmlFor={`outcome-date-${cardId}`}>Date</Label>
						<input
							id={`outcome-date-${cardId}`}
							type="date"
							className="block rounded-md border px-3 py-2 text-sm"
							value={date}
							min={firstDay}
							max={today}
							aria-describedby={`outcome-date-hint-${cardId}`}
							onChange={(event) => setDate(event.target.value)}
						/>
						<p
							id={`outcome-date-hint-${cardId}`}
							className={cn('text-sm', dateOk ? 'text-muted-foreground' : 'text-destructive')}
						>
							Pick a day from {formatDate(mailedAt)}, when the card was mailed, to today.
						</p>
					</div>
					<div className="space-y-1">
						<Label htmlFor={`outcome-note-${cardId}`}>Note</Label>
						<Textarea id={`outcome-note-${cardId}`} value={note} onChange={(event) => setNote(event.target.value)} />
					</div>
					{log.isError && <p className="text-sm text-destructive">{log.error.message}</p>}
					<DialogFooter>
						<Button variant="outline" onClick={() => setKind(null)}>
							Cancel
						</Button>
						<Button disabled={log.isPending || !dateOk} onClick={() => log.mutate()}>
							Save
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	)
}
