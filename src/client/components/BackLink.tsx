import { load, save } from '#client/lib/lists.ts'
import { isFresh, sectionOf } from '#client/nav.ts'
import { ChevronLeft } from 'lucide-react'
import { useEffect, useState, type MouseEvent } from 'react'
import { Link, NavigationType, useLocation, useNavigate, useNavigationType } from 'react-router'

// Where "Back to …" leads: the history entry it came from (its position, for a real Back), its URL and its name.
interface Back {
	idx: number
	href: string
	title: string
}

const isBack = (value: unknown): value is Back =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as Back).idx === 'number' &&
	typeof (value as Back).href === 'string' &&
	typeof (value as Back).title === 'string'
const stored = (key: string) => {
	const value = load(`back:${key}`)
	return isBack(value) ? value : null
}
// React Router keeps each entry's position in history.state.
const historyIdx = () => (window.history.state as { idx?: number } | null)?.idx ?? 0

const linkClass =
	'mb-3 inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'

// A page's name is its heading, read on every click: the click that navigates runs before the next page renders.
let lastClick: { key: string; title: string } | null = null

// Mounted once above every page. Arriving from another page by a link shows "Back to <that page>"; it goes back in
// history, so the page comes back as it was left (URL filters, list page). A header tab is a fresh start: no link.
// A detail page opened directly falls back to its section's list.
export function BackLink() {
	const location = useLocation()
	const navigationType = useNavigationType()
	const navigate = useNavigate()
	const here = { key: location.key, pathname: location.pathname, href: location.pathname + location.search }
	const [entry, setEntry] = useState({ ...here, idx: historyIdx() })
	const [back, setBack] = useState(() => stored(location.key))

	// A new history entry: work out where its back link points (kept in sessionStorage, so Back and reload find it).
	if (entry.key !== location.key) {
		setEntry({ ...here, idx: historyIdx() })
		if (navigationType === NavigationType.Pop) setBack(stored(location.key))
		else if (isFresh(location.state)) setBack(null)
		// Still the same page (a filter, a sheet): keep pointing at the page before it.
		else if (navigationType === NavigationType.Replace || entry.pathname === location.pathname)
			setBack(stored(entry.key))
		else
			setBack({
				idx: entry.idx,
				href: entry.href,
				title: (lastClick?.key === entry.key && lastClick.title) || sectionOf(entry.pathname)?.[1] || 'previous page',
			})
	}
	useEffect(() => save(`back:${location.key}`, back), [location.key, back])

	useEffect(() => {
		const remember = () => {
			lastClick = { key: location.key, title: document.querySelector('main h1')?.textContent?.trim() ?? '' }
		}
		document.addEventListener('click', remember, true)
		return () => document.removeEventListener('click', remember, true)
	}, [location.key])

	if (back) {
		const goBack = (event: MouseEvent) => {
			// Cmd/Ctrl-click and middle click still open the page in a new tab.
			if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
			event.preventDefault()
			const delta = back.idx - historyIdx()
			if (delta < 0) void navigate(delta)
			else void navigate(back.href)
		}
		return (
			<Link to={back.href} onClick={goBack} className={linkClass}>
				<ChevronLeft className="size-4" />
				Back to {back.title}
			</Link>
		)
	}
	const section = sectionOf(location.pathname)
	if (!section || section[0] === location.pathname) return null
	return (
		<Link to={section[0]} className={linkClass}>
			<ChevronLeft className="size-4" />
			{section[1]}
		</Link>
	)
}
