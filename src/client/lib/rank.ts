const fold = (text: string) =>
	text
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLocaleLowerCase()

// Best matches first: an exact hit, then texts that start with the term, then texts that contain it anywhere.
// Within a tier items keep their order, so an alphabetical list stays alphabetical. Accents are ignored.
export function rankMatches<T>(items: readonly T[], term: string, texts: (item: T) => string[]): T[] {
	const needle = fold(term.trim())
	if (!needle) return [...items]
	const tier = (item: T) => {
		const haystack = texts(item).map(fold)
		if (haystack.includes(needle)) return 0
		if (haystack.some((text) => text.startsWith(needle))) return 1
		return haystack.some((text) => text.includes(needle)) ? 2 : null
	}
	return items
		.map((item) => ({ item, rank: tier(item) }))
		.filter((match) => match.rank !== null)
		.sort((a, b) => a.rank! - b.rank!)
		.map((match) => match.item)
}
