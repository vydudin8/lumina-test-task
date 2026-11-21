import type { EvidenceItem, Rejection } from './types.ts'

// A number with its currency or percent sign: "$44,945,000" must not pass for "£44,945,000".
const NUMBER = /[£$€]?\d[\d,]*(?:\.\d+)?%?/g
// Numbers in words are claims too. "one" is left out: it is mostly not a quantity ("one of the largest").
const NUMBER_WORDS =
	/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|dozens?)\b/gi
const CONTACT_DATA: [RegExp, string][] = [
	[/[^\s@]+@[^\s@]+\.[a-z]{2,}/i, 'an email address'],
	[/(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,5}\)?[\s-]){2,}\d{3,}/, 'a phone number'],
	[/https?:\/\/|www\./i, 'a URL'],
]

export const contactDataIn = (text: string) =>
	CONTACT_DATA.filter(([pattern]) => pattern.test(text)).map(([, label]) => label)

const numbersIn = (text: string) =>
	(text.match(NUMBER) ?? []).map((number) => number.replace(/,/g, '').replace(/\.$/, ''))
const bare = (token: string) => token.replace(/[£$€%]/g, '')
const wordsIn = (text: string) => (text.match(NUMBER_WORDS) ?? []).map((word) => word.toLowerCase())

export type GuardResult = { ok: true; text: string; cites: string[] } | { ok: false; rejections: Rejection[] }

// The model may only restate the evidence it cites. Every check runs, so the UI can show all the reasons at once.
export function guardOutput(raw: string, evidence: EvidenceItem[], { maxChars }: { maxChars: number }): GuardResult {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return { ok: false, rejections: [{ code: 'invalid_json', detail: 'the answer is not JSON' }] }
	}
	const { text, cites } = (parsed ?? {}) as { text?: unknown; cites?: unknown }
	if (typeof text !== 'string' || !Array.isArray(cites) || !cites.every((cite) => typeof cite === 'string')) {
		return { ok: false, rejections: [{ code: 'invalid_json', detail: 'the answer is not {text, cites}' }] }
	}

	// NFKC turns full-width and other look-alike digits into plain ones before any check.
	const trimmed = text.normalize('NFKC').trim()
	if (!trimmed) return { ok: false, rejections: [{ code: 'empty_text', detail: 'the text is empty' }] }

	const rejections: Rejection[] = []
	if (trimmed.length > maxChars)
		rejections.push({ code: 'too_long', detail: `the text is ${trimmed.length} characters, the limit is ${maxChars}` })

	const byId = new Map(evidence.map((item) => [item.id, item]))
	const unknown = cites.filter((cite) => !byId.has(cite))
	if (cites.length === 0) rejections.push({ code: 'no_citation', detail: 'the answer cites no evidence' })
	for (const cite of unknown)
		rejections.push({ code: 'unknown_citation', detail: `cites ${cite}, which is not in the evidence` })

	const citedText = cites.map((cite) => byId.get(cite)?.value.normalize('NFKC') ?? '').join(' ')
	const allowed = new Set(numbersIn(citedText))
	const allowedBare = new Set([...allowed].map(bare))
	const allowedWords = new Set(wordsIn(citedText))
	// A bare number may match any cited figure; one with a currency or % sign must match that figure exactly.
	const uncited = [
		...new Set([
			...numbersIn(trimmed).filter((token) => (token === bare(token) ? !allowedBare.has(token) : !allowed.has(token))),
			...wordsIn(trimmed).filter((word) => !allowedWords.has(word)),
		]),
	]
	if (uncited.length === 1)
		rejections.push({ code: 'uncited_number', detail: `number '${uncited[0]}' is not in the evidence` })
	if (uncited.length > 1)
		rejections.push({
			code: 'uncited_number',
			detail: `numbers ${uncited.map((n) => `'${n}'`).join(', ')} are not in the evidence`,
		})

	const contact = contactDataIn(trimmed)
	if (contact.length)
		rejections.push({ code: 'contains_contact_data', detail: `the text contains ${contact.join(' and ')}` })

	return rejections.length ? { ok: false, rejections } : { ok: true, text: trimmed, cites: cites }
}
