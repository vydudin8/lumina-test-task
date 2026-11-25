import { Input } from '#client/components/ui/input.tsx'
import { cn } from '#client/lib/utils.ts'
import { Search, X } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState, type ComponentProps } from 'react'

const DEBOUNCE_MS = 300

// Applies itself a moment after typing stops; × or Escape clears at once.
export function SearchInput({
	value,
	onChange,
	className,
	...props
}: { value: string; onChange: (value: string) => void } & Omit<ComponentProps<'input'>, 'value' | 'onChange'>) {
	const [draft, setDraft] = useState(value)
	const [applied, setApplied] = useState(value)
	const input = useRef<HTMLInputElement>(null)
	// The value changed from outside (Clear filters, back button): show it.
	if (value !== applied) {
		setApplied(value)
		setDraft(value)
	}

	const apply = useEffectEvent((next: string) => onChange(next))
	useEffect(() => {
		if (draft === applied) return
		const timer = setTimeout(() => apply(draft), DEBOUNCE_MS)
		return () => clearTimeout(timer)
	}, [draft, applied])

	const clear = () => {
		setDraft('')
		onChange('')
		input.current?.focus()
	}

	return (
		<div className={cn('relative', className)}>
			<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input
				ref={input}
				type="search"
				className="px-8 [&::-webkit-search-cancel-button]:hidden"
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Escape' && draft) clear()
					if (event.key === 'Enter') onChange(draft)
				}}
				{...props}
			/>
			{draft && (
				<button
					type="button"
					aria-label="Clear search"
					className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					onClick={clear}
				>
					<X className="size-3.5" />
				</button>
			)}
		</div>
	)
}
