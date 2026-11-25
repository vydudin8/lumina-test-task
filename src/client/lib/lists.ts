import { isFresh } from '#client/nav.ts'
import { useEffect, useState } from 'react'
import { NavigationType, useLocation, useNavigationType, useSearchParams } from 'react-router'

// sessionStorage can be missing or throw (private mode, blocked site data); the list then simply forgets.
export function load(key: string): unknown {
	try {
		return JSON.parse(sessionStorage.getItem(key) ?? 'null')
	} catch {
		return null
	}
}

export function save(key: string, value: unknown) {
	try {
		sessionStorage.setItem(key, JSON.stringify(value))
	} catch {
		// Not remembered; the list still works.
	}
}

interface Pages {
	key: string
	cursors: string[]
}

const isPages = (value: unknown): value is Pages =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as Pages).key === 'string' &&
	Array.isArray((value as Pages).cursors) &&
	(value as Pages).cursors.every((cursor) => typeof cursor === 'string')

// Cursor pages for the keyset APIs: a stack of the cursors that led here, so Previous is a cache hit, not a refetch.
// The stack is kept per history entry, so going back (the browser's Back or the page's back link) lands on the same
// page, while arriving any other way (a header tab, a link) starts on page one.
// A cursor is the sort key of the row before the page, so rows added meanwhile show up without shifting it.
// Any change to `resetKey` (the filters) starts again from the first page.
export function useCursorPages(list: string, resetKey: string) {
	const location = useLocation()
	const navigationType = useNavigationType()
	const storageKey = `pages:${location.key}:${list}`
	const [state, setState] = useState<Pages>(() => {
		const stored = load(storageKey)
		return isPages(stored) ? stored : { key: resetKey, cursors: [] }
	})
	// Another history entry while this page stays open: Back or Forward brings back what that entry had, a header tab
	// starts over, and a new entry on the same page (a filter, a side sheet) starts as the last one was.
	const [entry, setEntry] = useState(location.key)
	if (entry !== location.key) {
		setEntry(location.key)
		const stored = load(storageKey)
		if (navigationType === NavigationType.Pop && isPages(stored)) setState(stored)
		else if (navigationType !== NavigationType.Pop && isFresh(location.state)) setState({ key: resetKey, cursors: [] })
	}
	useEffect(() => save(storageKey, state), [storageKey, state])
	const cursors = state.key === resetKey ? state.cursors : []
	const go = (next: string[]) => setState({ key: resetKey, cursors: next })
	return {
		cursor: cursors.at(-1),
		page: cursors.length,
		first: () => go([]),
		next: (cursor: string) => go([...cursors, cursor]),
		previous: () => go(cursors.slice(0, -1)),
		to: go,
	}
}

// Any state kept per history entry the same way: Back, Forward and a reload bring it back, arriving from a link or a
// header tab starts from `initial`, and a new entry on the same page (a filter) carries it over.
export function useEntryState<T>(name: string, initial: T, isValid: (value: unknown) => value is T) {
	const location = useLocation()
	const navigationType = useNavigationType()
	const storageKey = `${name}:${location.key}`
	const [state, setState] = useState<T>(() => {
		const stored = load(storageKey)
		return isValid(stored) ? stored : initial
	})
	const [entry, setEntry] = useState(location.key)
	if (entry !== location.key) {
		setEntry(location.key)
		const stored = load(storageKey)
		if (navigationType === NavigationType.Pop && isValid(stored)) setState(stored)
		else if (navigationType !== NavigationType.Pop && isFresh(location.state)) setState(initial)
	}
	useEffect(() => save(storageKey, state), [storageKey, state])
	return [state, setState] as const
}

// Filters live in the URL, so a filtered list can be shared, survives a reload and comes back with Back.
// An empty value removes the key.
export function useFilterParams() {
	const [params, setParams] = useSearchParams()
	const update = (changes: Record<string, string>, options?: { replace?: boolean }) =>
		setParams((current) => {
			const next = new URLSearchParams(current)
			for (const [key, value] of Object.entries(changes)) {
				if (value) next.set(key, value)
				else next.delete(key)
			}
			return next
		}, options)
	return [params, update] as const
}

// A sort header cycles: its natural direction, then reversed, then back to the list's default sort.
export function nextSort(column: string, first: 'asc' | 'desc', current: { sort: string; dir: string }) {
	if (current.sort !== column) return { sort: column, dir: first }
	if (current.dir === first) return { sort: column, dir: first === 'asc' ? 'desc' : 'asc' }
	return { sort: '', dir: '' }
}

const pad = (value: number) => String(value).padStart(2, '0')
// The browser's calendar day, not UTC's, so "today" is the day the user sees.
export const dayOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const DAY = /^\d{4}-\d{2}-\d{2}$/

// Midnight of a picked day in this browser's time zone, as an instant the API compares with; null for anything else.
export function dayStart(day: string, addDays = 0) {
	if (!DAY.test(day)) return null
	const [year, month, date] = day.split('-').map(Number) as [number, number, number]
	// A day that does not exist (2026-02-30) would roll over silently; it must read back as itself.
	if (dayOf(new Date(year, month - 1, date)) !== day) return null
	return new Date(year, month - 1, date + addDays).toISOString()
}

// When a reply or meeting on a picked day happened, as an instant: local noon, held inside [mailed, now] so the
// mailing day and this morning both work. The server refuses anything outside that range.
export function outcomeTime(day: string, mailedAt: string, now = new Date()) {
	const [year, month, date] = day.split('-').map(Number) as [number, number, number]
	const noon = new Date(year, month - 1, date, 12).getTime()
	return new Date(Math.min(Math.max(noon, new Date(mailedAt).getTime()), now.getTime())).toISOString()
}
