import { Tooltip, TooltipContent, TooltipTrigger } from '#client/components/ui/tooltip.tsx'
import { type CampaignCard } from '#client/domain/campaigns.ts'
import { cn } from '#client/lib/utils.ts'

// Same single-pass fill as the printed card (renderBack on the server); a line an AI or a person wrote is marked.
export function PostcardText({
	body,
	card,
	company,
	onEdit,
}: {
	body: string
	card: CampaignCard
	company: string
	onEdit?: () => void
}) {
	const values: Record<string, string> = {
		first_name: card.recipient?.firstName ?? 'there',
		personal_line: card.personalLine ?? '',
		company,
	}
	// split() with a capture group puts the placeholder names at the odd indexes.
	return body.split(/\{\{(first_name|personal_line|company)\}\}/g).map((part, index) => {
		if (index % 2 === 0) return part
		if (part === 'personal_line' && card.personalLine === null)
			return (
				<span key={index} className="text-muted-foreground italic">
					[the personal line is being written]
				</span>
			)
		if (part !== 'personal_line' || card.lineSource === 'template') return values[part]
		return (
			<Tooltip key={index}>
				<TooltipTrigger asChild>
					<mark
						tabIndex={0}
						role={onEdit && 'button'}
						// Selecting text to copy is not a click: a drag, double or triple click leaves a selection by the
						// time this runs, so only a plain click opens the editor.
						onClick={() => onEdit && setTimeout(() => !window.getSelection()?.toString() && onEdit(), 250)}
						onKeyDown={(event) => {
							if (!onEdit || (event.key !== 'Enter' && event.key !== ' ')) return
							event.preventDefault()
							onEdit()
						}}
						className={cn(
							'rounded-sm bg-warning-soft box-decoration-clone px-0.5 text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
							onEdit && 'cursor-pointer',
						)}
					>
						{values[part]}
					</mark>
				</TooltipTrigger>
				<TooltipContent>Customized line, please recheck{onEdit && '. Click to edit'}</TooltipContent>
			</Tooltip>
		)
	})
}
