import { ApiError } from '#client/lib/api.ts'
import type { UseQueryResult } from '@tanstack/react-query'
import { CircleAlert, LoaderCircle, RotateCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { isRouteErrorResponse, Link, useRouteError } from 'react-router'
import { Button } from './ui/button.tsx'

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
	if (query.isPending) return <Loading />
	if (query.isError) {
		if (query.error instanceof ApiError && query.error.status === 404)
			return <ErrorNotice title="Not found" detail={query.error.message} actions={false} />
		return <ErrorNotice title="Could not load this" detail={query.error.message} onRetry={() => void query.refetch()} />
	}
	if (empty && isEmpty?.(query.data)) return <p className="text-sm text-muted-foreground">{empty}</p>
	return <>{children(query.data)}</>
}

export function Loading() {
	return (
		<p role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
			<LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
			Loading…
		</p>
	)
}

// What went wrong in the server's or browser's own words, and a way out: try the request again or reload the page.
export function ErrorNotice({
	title,
	detail,
	onRetry,
	actions = true,
}: {
	title: string
	detail?: string
	onRetry?: () => void
	actions?: boolean
}) {
	return (
		<div role="alert" className="max-w-3xl rounded-lg border border-destructive/25 bg-destructive-soft p-4 text-sm">
			<div className="flex gap-3">
				<CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
				<div className="min-w-0 flex-1 space-y-3">
					<div className="space-y-1">
						<p className="font-medium text-destructive">{title}</p>
						{/* Server text can be one long unbroken string; it wraps instead of running off the screen. */}
						{detail && <p className="wrap-anywhere">{detail}</p>}
						{actions && (
							<p className="text-muted-foreground">
								Reloading the page usually fixes this. Anything already saved stays saved.
							</p>
						)}
					</div>
					{actions && (
						<div className="flex flex-wrap gap-2">
							{onRetry && (
								<Button size="sm" variant="outline" onClick={onRetry}>
									Try again
								</Button>
							)}
							<Button size="sm" variant="outline" onClick={() => window.location.reload()}>
								<RotateCw aria-hidden />
								Reload page
							</Button>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}

export function NotFound() {
	return (
		<div className="max-w-xl space-y-2">
			<h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
			<p className="text-muted-foreground">
				Nothing lives at this address.{' '}
				<Link to="/" className="text-link underline-offset-4 hover:underline">
					Go to the home page
				</Link>
			</p>
		</div>
	)
}

// The router's error boundary: a page that throws while rendering shows this instead of a blank screen.
export function RouteError() {
	const error = useRouteError()
	if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />
	return (
		<div className="space-y-4">
			<h1 className="text-2xl font-semibold tracking-tight">This page stopped working</h1>
			<ErrorNotice
				title="Something went wrong while showing this page"
				detail={error instanceof Error ? error.message : undefined}
			/>
		</div>
	)
}
