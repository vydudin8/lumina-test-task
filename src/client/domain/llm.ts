import { NUMBER, NUMBER_WORDS, numberKey } from '#common/numeric-claims.ts'

export interface Rejection {
	code: string
	detail: string
	values?: string[]
}

const PROBLEMS: Record<string, string> = {
	uncited_number: 'made-up number',
	unknown_citation: 'cites facts that do not exist',
	no_citation: 'cites no facts',
	too_long: 'too long',
	empty_text: 'empty answer',
	invalid_json: 'unreadable answer',
	contains_contact_data: 'contains contact details',
	api_error: 'AI service error',
	timeout: 'AI service timed out',
}

// Rows saved before the guard listed values only quote them in the detail: "numbers '120', 'hundreds' are not…".
export const madeUpNumbers = (rejection: Rejection) =>
	rejection.code !== 'uncited_number'
		? []
		: (rejection.values ?? [...rejection.detail.matchAll(/'([^']+)'/g)].map((match) => match[1]!))

// The guard's reasons in plain words, each once: "made-up numbers, too long".
export function rejectionSummary(rejections: Rejection[]) {
	const problems = rejections.map((rejection) =>
		madeUpNumbers(rejection).length > 1 ? 'made-up numbers' : (PROBLEMS[rejection.code] ?? rejection.code),
	)
	return [...new Set(problems)].join(', ')
}

// The text the model wrote, normalised the way the guard read it. An answer that is not {text} JSON shows as it came.
export function draftText(raw: string | null) {
	if (raw === null) return null
	try {
		const { text } = JSON.parse(raw) as { text?: unknown }
		if (typeof text === 'string') return text.normalize('NFKC').trim()
	} catch {
		// Not JSON: the raw answer is the draft.
	}
	return raw
}

const CLAIM = new RegExp(`${NUMBER.source}|${NUMBER_WORDS.source}`, 'gi')

// Splits the draft so each number the guard rejected can be marked where it stands.
export function markNumbers(text: string, values: string[]) {
	const rejected = new Set(values)
	const parts: { text: string; marked: boolean }[] = []
	let from = 0
	for (const match of text.matchAll(CLAIM)) {
		const token = match[0].replace(/,+$/, '')
		if (!rejected.has(numberKey(token))) continue
		if (match.index > from) parts.push({ text: text.slice(from, match.index), marked: false })
		parts.push({ text: token, marked: true })
		from = match.index + token.length
	}
	if (from < text.length) parts.push({ text: text.slice(from), marked: false })
	return parts
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Splits the explanation so each cited evidence item gets its mark after the words that quote it, the way Wikipedia
// marks references. An item is found by its value, or by one of its "; " parts, ignoring case and never inside a longer
// word or number. Longer values pick first, so "Construction" inside a company's name stays the name's. Items the
// text does not quote (a score summary, a rule) are marked at the end.
export function placeCitations(text: string, items: { id: string; value: string }[]) {
	const taken: [number, number][] = []
	const marks = new Map<number, string[]>()
	const mark = (at: number, id: string) => marks.set(at, [...(marks.get(at) ?? []), id])
	const find = (needle: string) => {
		const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}]|[.,]\\p{N})`, 'giu')
		for (const match of text.matchAll(pattern)) {
			const span: [number, number] = [match.index, match.index + match[0].length]
			if (taken.every(([from, to]) => span[1] <= from || span[0] >= to)) return span
		}
		return null
	}
	for (const item of [...items].sort((a, b) => b.value.length - a.value.length)) {
		const needles = [item.value, ...item.value.split('; ')].map((needle) => needle.trim()).filter(Boolean)
		let span: [number, number] | null = null
		for (const needle of needles) if ((span = find(needle))) break
		if (span) taken.push(span)
		mark(span ? span[1] : text.length, item.id)
	}
	const order = new Map(items.map((item, index) => [item.id, index]))
	const parts: { text: string; cites: string[] }[] = []
	let from = 0
	for (const at of [...marks.keys()].sort((a, b) => a - b)) {
		parts.push({ text: text.slice(from, at), cites: marks.get(at)!.sort((a, b) => order.get(a)! - order.get(b)!) })
		from = at
	}
	if (from < text.length || parts.length === 0) parts.push({ text: text.slice(from), cites: [] })
	return parts
}
