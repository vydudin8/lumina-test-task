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
import { useState, type ReactNode } from 'react'

// Every human decision that changes data asks why; the answer goes to the audit log.
export function ReasonDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	disabled,
	onConfirm,
	children,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	title: string
	description: string
	confirmLabel: string
	disabled?: boolean
	onConfirm: (reason: string) => Promise<unknown>
	children?: ReactNode
}) {
	const [reason, setReason] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)

	const close = (next: boolean) => {
		if (!next) {
			setReason('')
			setError(null)
		}
		onOpenChange(next)
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{children}
				<div className="space-y-2">
					<Label htmlFor="reason">Reason (saved in the audit log)</Label>
					<Textarea id="reason" value={reason} onChange={(event) => setReason(event.target.value)} />
				</div>
				{error && <p className="text-sm text-destructive">{error}</p>}
				<DialogFooter>
					<Button variant="outline" onClick={() => close(false)}>
						Cancel
					</Button>
					<Button
						disabled={disabled || saving || reason.trim() === ''}
						onClick={() => {
							setSaving(true)
							onConfirm(reason)
								.then(() => close(false))
								.catch((cause: Error) => setError(cause.message))
								.finally(() => setSaving(false))
						}}
					>
						{saving ? 'Saving…' : confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
