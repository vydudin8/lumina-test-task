import { useEffect, useState } from 'react'

// The value as it was `ms` after it last changed: for requests that should follow typing, not every keystroke.
export function useDebounced<T>(value: T, ms: number) {
	const [debounced, setDebounced] = useState(value)
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), ms)
		return () => clearTimeout(timer)
	}, [value, ms])
	return debounced
}
