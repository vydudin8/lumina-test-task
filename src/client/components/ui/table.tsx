'use client'

import { cn } from '#client/lib/utils.ts'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import * as React from 'react'

// `className` sizes the bordered container; the table always fills it.
function Table({ className, ...props }: React.ComponentProps<'table'>) {
	return (
		<div
			data-slot="table-container"
			className={cn('relative w-full overflow-x-auto rounded-lg border bg-card', className)}
		>
			<table data-slot="table" className="w-full caption-bottom text-sm" {...props} />
		</div>
	)
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
	return <thead data-slot="table-header" className={cn('bg-muted/60 [&_tr]:border-b', className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
	return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
	return (
		<tfoot
			data-slot="table-footer"
			className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
			{...props}
		/>
	)
}

// Only rows that do something on click get the hover, so a highlight always means "you can open this".
function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
	return (
		<tr
			data-slot="table-row"
			className={cn(
				'border-b transition-colors has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted',
				props.onClick && 'cursor-pointer hover:bg-muted/70',
				className,
			)}
			{...props}
		/>
	)
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
	return (
		<th
			data-slot="table-head"
			className={cn(
				'h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
				className,
			)}
			{...props}
		/>
	)
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
	return (
		<td
			data-slot="table-cell"
			className={cn(
				'px-3 py-2.5 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
				className,
			)}
			{...props}
		/>
	)
}

// A column header that sorts: the arrow shows the current direction, a click asks for the next one.
function TableSortHead({
	label,
	direction,
	onSort,
	className,
}: {
	label: string
	direction: 'asc' | 'desc' | null
	onSort: () => void
	className?: string
}) {
	const Icon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ChevronsUpDown
	return (
		<TableHead
			aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : undefined}
			className={className}
		>
			<button
				type="button"
				onClick={onSort}
				className={cn(
					'-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
					direction && 'text-foreground',
				)}
			>
				{label}
				<Icon className={cn('size-3.5', !direction && 'opacity-40')} />
			</button>
		</TableHead>
	)
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
	return (
		<caption data-slot="table-caption" className={cn('mt-4 text-sm text-muted-foreground', className)} {...props} />
	)
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow, TableSortHead }
