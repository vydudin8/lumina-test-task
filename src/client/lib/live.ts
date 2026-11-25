import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { useEffect } from 'react'

// Long enough that a burst of webhooks is one refetch; the jitter spreads many open tabs over half a second more.
export const COALESCE_MS = 1000
export const JITTER_MS = 500
const REOPEN_MS = 5000

// What a server notice makes stale. 'resync' (after the server's own connection dropped) and anything unknown refetch
// everything the stream covers, which is always safe.
export function keysFor(payload: string): QueryKey[] {
	const campaignId = /^campaign:(\d+)$/.exec(payload)?.[1]
	// A key matches by prefix: ['campaign', id] also covers the campaign's cards and history, keyed under it.
	if (campaignId) return [['campaign', Number(campaignId)], ['campaigns'], ['results', Number(campaignId)]]
	// A new reply, visit or meeting names each campaign it can count for; other campaigns' panels stay as they are.
	const resultsId = /^results:(\d+)$/.exec(payload)?.[1]
	if (resultsId) return [['results', Number(resultsId)]]
	// A pull moved along: its panel, the run lists, the run's page and the records it stored.
	const runId = /^run:(\d+)$/.exec(payload)?.[1]
	if (runId) return [['providers'], ['ingestion-runs'], ['ingestion-run', runId], ['raw-records']]
	return [
		['campaign'],
		['campaigns'],
		['results'],
		['providers'],
		['ingestion-runs'],
		['ingestion-run'],
		['raw-records'],
	]
}

// A burst of notices (a webhook per card) invalidates each key once per window instead of once per notice.
export function createInvalidator(
	invalidate: (key: QueryKey) => void,
	delayMs = COALESCE_MS,
	jitter = () => Math.random() * JITTER_MS,
) {
	const pending = new Map<string, QueryKey>()
	let timer: ReturnType<typeof setTimeout> | undefined
	return {
		push(keys: QueryKey[]) {
			for (const key of keys) pending.set(JSON.stringify(key), key)
			timer ??= setTimeout(() => {
				timer = undefined
				const due = [...pending.values()]
				pending.clear()
				for (const key of due) invalidate(key)
			}, delayMs + jitter())
		},
		stop() {
			clearTimeout(timer)
			pending.clear()
		},
	}
}

// One server-sent-events connection for the whole app. The server says what changed; active queries refetch.
export function useLiveUpdates(enabled: boolean) {
	const queryClient = useQueryClient()
	useEffect(() => {
		if (!enabled) return
		const invalidate = (queryKey: QueryKey) => void queryClient.invalidateQueries({ queryKey })
		const invalidator = createInvalidator(invalidate)
		// A pull sends three notices (queued, running, ended), never a burst: they refetch almost at once, so the panel
		// and the pull's toast keep up with a pull that takes a fraction of a second.
		const runs = createInvalidator(invalidate, 100, () => 0)
		let source: EventSource
		let reopen: ReturnType<typeof setTimeout> | undefined
		let dropped = false

		const open = () => {
			source = new EventSource('/api/stream')
			source.addEventListener('change', (event: MessageEvent<string>) =>
				(/^run:\d+$/.test(event.data) ? runs : invalidator).push(keysFor(event.data)),
			)
			source.onopen = () => {
				// Notices sent while the stream was down are lost.
				if (dropped) invalidator.push(keysFor('resync'))
				dropped = false
			}
			source.onerror = () => {
				dropped = true
				// A network error reconnects by itself; an HTTP error (a proxy's 502 during a restart) ends the source for good.
				if (source.readyState === EventSource.CLOSED) reopen = setTimeout(open, REOPEN_MS)
			}
		}
		open()
		return () => {
			clearTimeout(reopen)
			source.close()
			invalidator.stop()
			runs.stop()
		}
	}, [queryClient, enabled])
}
