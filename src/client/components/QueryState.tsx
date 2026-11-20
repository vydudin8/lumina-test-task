import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'

// Every data view says plainly whether it is loading, failed or empty, instead of showing a blank table.
export function QueryState<T>({
	query,
	empty,
	isEmpty,
	children,
}: {
	query: UseQueryResult<T>
	empty?: string
	isEmpty?: (data: T) => boolean
	children: (data: T) => ReactNode
}) {
	if (query.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>
	if (query.isError) return <p className="text-sm text-destructive">Could not load this: {query.error.message}</p>
	if (empty && isEmpty?.(query.data)) return <p className="text-sm text-muted-foreground">{empty}</p>
	return <>{children(query.data)}</>
}
