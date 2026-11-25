import { Button } from '#client/components/ui/button.tsx'
import { formatInteger } from '#client/lib/format.ts'
import { ChevronLeft, ChevronRight, ChevronsLeft } from 'lucide-react'

export function Pager({
	page,
	pageSize,
	shown,
	total,
	onFirst,
	onPrevious,
	onNext,
}: {
	page: number
	pageSize: number
	shown: number
	total: number
	onFirst: (() => void) | null
	onPrevious: (() => void) | null
	onNext: (() => void) | null
}) {
	if (total <= pageSize && page === 0) return null
	const from = page * pageSize + 1
	return (
		<div className="flex items-center justify-between gap-3 text-sm">
			<span className="text-muted-foreground tabular-nums">
				{formatInteger(from)}–{formatInteger(from + shown - 1)} of {formatInteger(total)}
			</span>
			<div className="flex gap-2">
				<Button size="sm" variant="outline" disabled={!onFirst} onClick={onFirst ?? undefined}>
					<ChevronsLeft />
					First
				</Button>
				<Button size="sm" variant="outline" disabled={!onPrevious} onClick={onPrevious ?? undefined}>
					<ChevronLeft />
					Previous
				</Button>
				<Button size="sm" variant="outline" disabled={!onNext} onClick={onNext ?? undefined}>
					Next
					<ChevronRight />
				</Button>
			</div>
		</div>
	)
}
