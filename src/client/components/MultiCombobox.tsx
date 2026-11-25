import { rankMatches } from '#client/lib/rank.ts'
import { cn } from '#client/lib/utils.ts'
import { Check, X } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useEffect, useId, useRef, useState } from 'react'

interface Option {
	value: string
	label: string
}

// Pick several options by typing: best matches first (see rankMatches), arrows and Enter to choose, Backspace to drop the last.
export function MultiCombobox({
	options,
	value,
	onChange,
	label,
	placeholder,
	empty,
}: {
	options: readonly Option[]
	value: string[]
	onChange: (value: string[]) => void
	label: string
	placeholder: string
	empty: string
}) {
	const [term, setTerm] = useState('')
	const [open, setOpen] = useState(false)
	const [active, setActive] = useState(0)
	const anchor = useRef<HTMLDivElement>(null)
	const input = useRef<HTMLInputElement>(null)
	const listId = useId()
	const matches = rankMatches(options, term, (option) => [option.label, option.value])
	const labelOf = (code: string) => options.find((option) => option.value === code)?.label ?? code

	useEffect(() => {
		if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
	}, [open, active, listId])

	const search = (next: string) => {
		setTerm(next)
		setActive(0)
		setOpen(true)
	}
	const toggle = (option: Option) => {
		onChange(value.includes(option.value) ? value.filter((v) => v !== option.value) : [...value, option.value])
		search('')
	}

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Anchor asChild>
				<div
					ref={anchor}
					className="flex min-h-9 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-input bg-card px-1.5 py-1 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
					onClick={() => {
						input.current?.focus()
						setOpen(true)
					}}
				>
					{value.map((code) => (
						<span
							key={code}
							className="inline-flex items-center gap-1 rounded-sm bg-muted py-0.5 pr-0.5 pl-1.5 text-xs font-medium"
						>
							{labelOf(code)}
							<span className="text-muted-foreground">{code}</span>
							<button
								type="button"
								aria-label={`Remove ${labelOf(code)}`}
								className="grid size-4 place-items-center rounded-xs text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
								onClick={(event) => {
									event.stopPropagation()
									onChange(value.filter((v) => v !== code))
								}}
							>
								<X className="size-3" />
							</button>
						</span>
					))}
					<input
						ref={input}
						role="combobox"
						aria-label={label}
						aria-expanded={open}
						aria-controls={listId}
						aria-autocomplete="list"
						aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
						placeholder={value.length ? '' : placeholder}
						className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
						value={term}
						onChange={(event) => search(event.target.value)}
						onFocus={() => setOpen(true)}
						onKeyDown={(event) => {
							if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
								event.preventDefault()
								const step = event.key === 'ArrowDown' ? 1 : -1
								setOpen(true)
								setActive((current) => Math.min(Math.max(current + step, 0), Math.max(matches.length - 1, 0)))
							} else if (event.key === 'Enter' && open && matches[active]) {
								event.preventDefault()
								toggle(matches[active])
							} else if (event.key === 'Backspace' && !term && value.length) {
								onChange(value.slice(0, -1))
							} else if (event.key === 'Tab') {
								setOpen(false)
							}
						}}
					/>
				</div>
			</Popover.Anchor>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={4}
					// Focus stays in the input, so typing keeps filtering while the list is open.
					onOpenAutoFocus={(event) => event.preventDefault()}
					onCloseAutoFocus={(event) => event.preventDefault()}
					onInteractOutside={(event) => {
						if (anchor.current?.contains(event.target as Node)) event.preventDefault()
					}}
					className="z-50 w-(--radix-popover-trigger-width) min-w-64 rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
				>
					{matches.length === 0 ? (
						<p className="px-2 py-1.5 text-sm text-muted-foreground">{empty}</p>
					) : (
						<ul id={listId} role="listbox" aria-label={label} aria-multiselectable className="max-h-64 overflow-y-auto">
							{matches.map((option, index) => {
								const selected = value.includes(option.value)
								return (
									<li
										key={option.value}
										id={`${listId}-${index}`}
										role="option"
										aria-selected={selected}
										className={cn(
											'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
											index === active && 'bg-accent text-accent-foreground',
										)}
										// Keep focus in the input; the click still toggles.
										onMouseDown={(event) => event.preventDefault()}
										onMouseMove={() => setActive(index)}
										onClick={() => toggle(option)}
									>
										<Check className={cn('size-4 shrink-0', !selected && 'invisible')} />
										{option.label}
										<span className="ml-auto text-xs text-muted-foreground">{option.value}</span>
									</li>
								)
							})}
						</ul>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	)
}
