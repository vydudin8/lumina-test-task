import { rankMatches } from '#client/lib/rank.ts'
import { cn } from '#client/lib/utils.ts'
import { Plus } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useEffect, useId, useRef, useState, type ComponentProps } from 'react'

// Free text with suggestions: existing values that match come first (see rankMatches), and anything new can be
// added from the list or with Enter, unless allowNew is off. A value that differs from an existing one only in
// case becomes that one.
export function SuggestInput({
	value,
	onChange,
	options,
	allowNew = true,
	className,
	...props
}: {
	value: string
	onChange: (value: string) => void
	options: string[]
	allowNew?: boolean
} & Omit<ComponentProps<'input'>, 'value' | 'onChange'>) {
	const [open, setOpen] = useState(false)
	const [active, setActive] = useState(-1)
	const input = useRef<HTMLInputElement>(null)
	const listId = useId()
	const typed = value.trim()
	const existing = options.find((option) => option.toLowerCase() === typed.toLowerCase())
	const rows = [
		...rankMatches(options, typed, (option) => [option]).map((text) => ({ text, isNew: false })),
		...(allowNew && typed && !existing ? [{ text: typed, isNew: true }] : []),
	]

	useEffect(() => {
		if (open && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
	}, [open, active, listId])

	const choose = (text: string) => {
		onChange(text)
		setOpen(false)
		setActive(-1)
	}

	return (
		<Popover.Root open={open && rows.length > 0} onOpenChange={setOpen}>
			<Popover.Anchor asChild>
				<input
					ref={input}
					role="combobox"
					aria-expanded={open && rows.length > 0}
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
					autoComplete="off"
					className={cn(
						'h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm',
						className,
					)}
					value={value}
					onChange={(event) => {
						onChange(event.target.value)
						setOpen(true)
						setActive(-1)
					}}
					onFocus={() => setOpen(true)}
					onClick={() => setOpen(true)}
					onKeyDown={(event) => {
						if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
							event.preventDefault()
							setOpen(true)
							const step = event.key === 'ArrowDown' ? 1 : -1
							setActive((current) => Math.min(Math.max(current + step, 0), rows.length - 1))
						} else if (event.key === 'Enter' && open && rows.length > 0) {
							// The first Enter settles the value; the next one submits the form.
							event.preventDefault()
							const row = rows[active]
							if (row) choose(row.text)
							else if (existing) choose(existing)
							else if (allowNew && typed) choose(typed)
							else setOpen(false)
						} else if (event.key === 'Tab') {
							setOpen(false)
						}
					}}
					{...props}
				/>
			</Popover.Anchor>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={4}
					onOpenAutoFocus={(event) => event.preventDefault()}
					onCloseAutoFocus={(event) => event.preventDefault()}
					onInteractOutside={(event) => {
						if (event.target === input.current) event.preventDefault()
					}}
					className="z-50 w-(--radix-popover-trigger-width) rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
				>
					<ul id={listId} role="listbox" className="max-h-60 overflow-y-auto">
						{rows.map((row, index) => (
							<li
								key={`${row.isNew}-${row.text}`}
								id={`${listId}-${index}`}
								role="option"
								aria-selected={index === active}
								className={cn(
									'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
									index === active && 'bg-accent text-accent-foreground',
								)}
								onMouseDown={(event) => event.preventDefault()}
								onMouseMove={() => setActive(index)}
								onClick={() => choose(row.text)}
							>
								{row.isNew ? (
									<>
										<Plus className="size-4 text-muted-foreground" />
										Add “{row.text}”
									</>
								) : (
									row.text
								)}
							</li>
						))}
					</ul>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	)
}
