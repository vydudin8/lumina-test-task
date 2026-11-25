import { SearchInput } from '#client/components/SearchInput.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Input } from '#client/components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#client/components/ui/select.tsx'
import { dayOf } from '#client/lib/lists.ts'
import { cn } from '#client/lib/utils.ts'
import { CalendarDays, Check, ChevronDown, X } from 'lucide-react'
import { DropdownMenu, Popover, Slider } from 'radix-ui'
import { useState, type ComponentProps, type ReactNode } from 'react'

// Radix Select cannot hold an empty value, so "no filter" travels as this sentinel inside the select only.
const ALL = '__all'

// The one layout every filtered list uses. With a search box: search and count on top, the selects and Clear filters
// on a row of their own below, so neither row has to wrap. Without one: selects, Clear filters, count on one row.
export function FilterBar({
	search,
	children,
	active,
	onClear,
	count,
}: {
	search?: { label: string; placeholder: string; value: string; onChange: (value: string) => void }
	children?: ReactNode
	active: boolean
	onClear: () => void
	count?: string
}) {
	const clear = active && (
		<Button size="sm" variant="ghost" onClick={onClear} className="text-muted-foreground hover:text-foreground">
			<X />
			Clear filters
		</Button>
	)
	const total = count && (
		<span className="ml-auto text-sm whitespace-nowrap text-muted-foreground tabular-nums">{count}</span>
	)
	if (!search)
		return (
			<div className="flex flex-wrap items-center gap-2">
				{children}
				{clear}
				{total}
			</div>
		)
	return (
		<div className="space-y-3">
			<div className="flex items-center gap-3">
				<SearchInput
					aria-label={search.label}
					placeholder={search.placeholder}
					className="w-full sm:w-96"
					value={search.value}
					onChange={search.onChange}
				/>
				{!children && clear}
				{total}
			</div>
			{children && (
				<div className="flex flex-wrap items-center gap-2">
					{children}
					{clear}
				</div>
			)}
		</div>
	)
}

// A select whose first option means "no filter"; an empty string in and out stands for it.
export function FilterSelect({
	label,
	all,
	value,
	onChange,
	options,
}: {
	label: string
	all: string
	value: string
	onChange: (value: string) => void
	options: readonly (readonly [value: string, text: string])[]
}) {
	return (
		<Select value={value || ALL} onValueChange={(next) => onChange(next === ALL ? '' : next)}>
			<SelectTrigger aria-label={label} className={cn('min-w-36', value && activeClass)}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>{all}</SelectItem>
				{options.map(([option, text]) => (
					<SelectItem key={option} value={option}>
						{text}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

// Looks like the select trigger, so every filter in the bar reads as one family.
const triggerClass =
	'flex h-9 min-w-36 items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm whitespace-nowrap shadow-xs outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent'
// A filter that narrows the list is tinted, so the bar shows at a glance which ones are set; unset ones stay white.
const activeClass = 'border-link/40 bg-link/5 hover:bg-link/10 data-[state=open]:bg-link/10'
const panelClass =
	'z-50 rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0'

// Radix hands its trigger props (ref, state, handlers) to this button through asChild, so they are spread.
function Trigger({
	text,
	active,
	icon,
	...props
}: { text: string; active: boolean; icon?: ReactNode } & ComponentProps<'button'>) {
	return (
		<button type="button" className={cn(triggerClass, active && activeClass)} {...props}>
			{icon}
			<span className="mr-auto max-w-60 truncate">{text}</span>
			<ChevronDown className="size-4 shrink-0 opacity-50" />
		</button>
	)
}

// Pick none (no filter), one or several values; the menu stays open while ticking.
export function FilterMultiSelect({
	label,
	all,
	value,
	onChange,
	options,
}: {
	label: string
	all: string
	value: string[]
	onChange: (value: string[]) => void
	options: readonly (readonly [value: string, text: string])[]
}) {
	const textOf = (option: string) => options.find(([candidate]) => candidate === option)?.[1] ?? option
	// The visible text names the filter, so it doubles as the accessible name.
	const text =
		value.length === 0 ? all : `${label}: ${textOf(value[0]!)}${value.length > 1 ? ` +${value.length - 1}` : ''}`
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<Trigger text={text} active={value.length > 0} />
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="start"
					sideOffset={4}
					className={cn(panelClass, 'max-h-80 min-w-(--radix-dropdown-menu-trigger-width) overflow-y-auto')}
				>
					{options.map(([option, optionText]) => (
						<DropdownMenu.CheckboxItem
							key={option}
							checked={value.includes(option)}
							onCheckedChange={(on) => onChange(on ? [...value, option] : value.filter((v) => v !== option))}
							onSelect={(event) => event.preventDefault()}
							className="group flex cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-3 pl-2 text-sm outline-none select-none data-[highlighted]:bg-accent"
						>
							{/* The item carries data-state, not this box, so the box reads it through the group. */}
							<span className="grid size-4 shrink-0 place-items-center rounded-[4px] border border-input bg-card group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary">
								<DropdownMenu.ItemIndicator>
									<Check className="size-3 text-primary-foreground" />
								</DropdownMenu.ItemIndicator>
							</span>
							{optionText}
						</DropdownMenu.CheckboxItem>
					))}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	)
}

type Bounds = [number | null, number | null]

// Two thumbs over fixed stops: the left end means no minimum, the right end no maximum. Applies on release.
export function FilterRange({
	label,
	stops,
	value,
	onChange,
	format,
}: {
	label: string
	stops: readonly number[]
	value: Bounds
	onChange: (value: Bounds) => void
	format: (value: number) => string
}) {
	const toPositions = ([min, max]: Bounds) => [
		min === null
			? 0
			: Math.max(
					stops.findLastIndex((stop) => stop <= min),
					0,
				),
		max === null
			? stops.length
			: Math.max(
					stops.findIndex((stop) => stop >= max),
					1,
				),
	]
	const toBounds = ([low = 0, high = stops.length]: number[]): Bounds => [
		low === 0 ? null : stops[low]!,
		high === stops.length ? null : stops[high]!,
	]
	const valueKey = value.join('|')
	const [drag, setDrag] = useState<{ from: string; positions: number[] } | null>(null)
	// While dragging, show the thumbs where they are; once the URL changes (release, Clear filters), follow it.
	const dragging = drag?.from === valueKey ? drag.positions : null
	const positions = dragging ?? toPositions(value)
	const [min, max] = dragging ? toBounds(dragging) : value
	const describe = (min: number | null, max: number | null) =>
		min !== null && max !== null
			? `${format(min)}–${format(max)}`
			: min !== null
				? `${format(min)} or more`
				: max !== null
					? `up to ${format(max)}`
					: 'any'
	const active = value[0] !== null || value[1] !== null

	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<Trigger text={active ? `${label}: ${describe(...value)}` : `Any ${label.toLowerCase()}`} active={active} />
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content align="start" sideOffset={4} className={cn(panelClass, 'w-72 space-y-4 p-4')}>
					<div className="flex items-baseline justify-between gap-2 text-sm">
						<span className="font-medium">{label}</span>
						<span className="text-muted-foreground tabular-nums">{describe(min, max)}</span>
					</div>
					<Slider.Root
						min={0}
						max={stops.length}
						step={1}
						minStepsBetweenThumbs={1}
						value={positions}
						onValueChange={(next) => setDrag({ from: valueKey, positions: next })}
						onValueCommit={(next) => {
							setDrag(null)
							onChange(toBounds(next))
						}}
						className="relative flex h-5 touch-none items-center select-none"
					>
						<Slider.Track className="relative h-1.5 grow rounded-full bg-muted">
							<Slider.Range className="absolute h-full rounded-full bg-primary" />
						</Slider.Track>
						{(['Minimum', 'Maximum'] as const).map((end) => (
							<Slider.Thumb
								key={end}
								aria-label={`${end} ${label.toLowerCase()}`}
								className="block size-4 cursor-grab rounded-full border-2 border-primary bg-card shadow-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
							/>
						))}
					</Slider.Root>
					<div className="flex justify-between text-xs text-muted-foreground">
						<span>No minimum</span>
						<span>No maximum</span>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	)
}

// Picked days as `YYYY-MM-DD`; an empty string leaves that end open.
export interface DayRange {
	from: string
	to: string
}

const days = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' })

function presets(): (readonly [label: string, range: DayRange])[] {
	const now = new Date()
	const ago = (count: number) => dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - count))
	return [
		['Today', { from: ago(0), to: ago(0) }],
		['Last 7 days', { from: ago(6), to: ago(0) }],
		['Last 30 days', { from: ago(29), to: ago(0) }],
		['This month', { from: dayOf(new Date(now.getFullYear(), now.getMonth(), 1)), to: ago(0) }],
	]
}

// A date range: quick presets, or the browser's own date pickers for each end. Applies as soon as a day is picked.
export function FilterDateRange({
	label,
	value,
	onChange,
}: {
	label: string
	value: DayRange
	onChange: (value: DayRange) => void
}) {
	const { from, to } = value
	const show = (day: string) => days.format(new Date(`${day}T00:00`))
	const text =
		from && to
			? days.formatRange(new Date(`${from}T00:00`), new Date(`${to}T00:00`))
			: from
				? `From ${show(from)}`
				: to
					? `Until ${show(to)}`
					: 'Any date'
	const active = Boolean(from || to)
	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<Trigger
					text={text}
					active={active}
					aria-label={`${label}: ${text}`}
					icon={<CalendarDays className="size-4 shrink-0 opacity-50" />}
				/>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content align="start" sideOffset={4} className={cn(panelClass, 'w-96 space-y-4 p-4')}>
					<div className="flex flex-wrap gap-1.5">
						{presets().map(([name, range]) => {
							const on = range.from === from && range.to === to
							return (
								<button
									key={name}
									type="button"
									aria-pressed={on}
									onClick={() => onChange(range)}
									className={cn(
										'rounded-full border px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
										on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent',
									)}
								>
									{name}
								</button>
							)
						})}
					</div>
					<div className="grid grid-cols-2 gap-3">
						{(
							[
								['From', from, { max: to || undefined }, (day: string) => onChange({ from: day, to })],
								['To', to, { min: from || undefined }, (day: string) => onChange({ from, to: day })],
							] as const
						).map(([name, day, bounds, set]) => (
							<label key={name} className="space-y-1.5 text-xs font-medium text-muted-foreground">
								<span>{name}</span>
								<Input type="date" value={day} {...bounds} onChange={(event) => set(event.target.value)} />
							</label>
						))}
					</div>
					{active && (
						<Button size="sm" variant="ghost" className="w-full" onClick={() => onChange({ from: '', to: '' })}>
							<X />
							Clear
						</Button>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	)
}
