export const TARGET_FUNCTIONS = ['operations', 'fleet', 'procurement', 'sustainability'] as const
export type TargetFunction = (typeof TARGET_FUNCTIONS)[number]
const SENIORITY_ORDER = ['c_suite', 'vp', 'director', 'head', 'manager', 'other']

// Provider function labels we trust as-is. Broad departments (e.g. Apollo's master_operations) are ignored on purpose.
const FUNCTION_LABELS: Record<string, TargetFunction> = {
	operations: 'operations',
	purchasing: 'procurement',
	procurement: 'procurement',
	sustainability: 'sustainability',
	'corporate social responsibility': 'sustainability',
	esg: 'sustainability',
}
const TITLE_KEYWORDS: [RegExp, TargetFunction][] = [
	[/\boperations\b|\bchief operating officer\b|\bcoo\b/i, 'operations'],
	[/\b(plant|fleet|equipment)\b/i, 'fleet'],
	[/\b(procurement|purchasing|buyer)\b/i, 'procurement'],
	[/\b(sustainability|esg|environment\w*)\b/i, 'sustainability'],
]

export function targetFunction({
	title,
	functions,
}: {
	title: string | null
	functions: string[]
}): TargetFunction | null {
	const found = [
		...functions.flatMap((label) => (FUNCTION_LABELS[label] ? [FUNCTION_LABELS[label]] : [])),
		...TITLE_KEYWORDS.filter(([pattern]) => pattern.test(title ?? '')).map(([, target]) => target),
	]
	return TARGET_FUNCTIONS.find((target) => found.includes(target)) ?? null
}

export interface RecipientContact {
	id: number
	personKey: string
	fullName: string | null
	firstName: string | null
	title: string | null
	seniority: string
	functions: string[]
	provider: string
	fetchedAt: string
}

export interface Candidate {
	personKey: string
	contactId: number
	contactIds: number[]
	fullName: string | null
	firstName: string | null
	title: string | null
	function: TargetFunction | null
	seniority: string
	providers: string[]
	latestFetchedAt: string
}

export type DecidedBy = 'only candidate' | 'function' | 'seniority' | 'corroboration' | 'freshness' | 'contact id'

const rank = (candidate: Candidate) => [
	candidate.function === null ? TARGET_FUNCTIONS.length : TARGET_FUNCTIONS.indexOf(candidate.function),
	SENIORITY_ORDER.indexOf(candidate.seniority),
	-candidate.providers.length,
	-Date.parse(candidate.latestFetchedAt),
	Math.min(...candidate.contactIds),
]
const STEPS: DecidedBy[] = ['function', 'seniority', 'corroboration', 'freshness', 'contact id']

// The fixed chain: target function, then seniority, then providers that know the person, then freshness, then id.
// Eligibility plays no part, so a suppressed recipient is never quietly swapped for a colleague.
export function chooseRecipient(
	contacts: RecipientContact[],
): { chosen: Candidate; candidates: Candidate[]; decidedBy: DecidedBy } | null {
	const people = new Map<string, RecipientContact[]>()
	for (const contact of contacts) people.set(contact.personKey, [...(people.get(contact.personKey) ?? []), contact])

	const candidates = [...people].map(([personKey, records]): Candidate => {
		const representative = [...records].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || a.id - b.id)[0]!
		const functions = records.map(targetFunction).filter((value): value is TargetFunction => value !== null)
		const seniorities = records
			.map((record) => record.seniority)
			.sort((a, b) => SENIORITY_ORDER.indexOf(a) - SENIORITY_ORDER.indexOf(b))
		return {
			personKey,
			contactId: representative.id,
			contactIds: records.map((record) => record.id).sort((a, b) => a - b),
			fullName: representative.fullName,
			firstName: representative.firstName,
			title: representative.title,
			function: TARGET_FUNCTIONS.find((target) => functions.includes(target)) ?? null,
			seniority: seniorities[0] ?? 'other',
			providers: [...new Set(records.map((record) => record.provider))].sort(),
			latestFetchedAt: representative.fetchedAt,
		}
	})
	if (candidates.length === 0) return null

	const compare = (a: Candidate, b: Candidate) => {
		const [x, y] = [rank(a), rank(b)]
		const step = x.findIndex((value, index) => value !== y[index])
		return step === -1 ? 0 : x[step]! - y[step]!
	}
	candidates.sort(compare)
	const [chosen, runnerUp] = candidates as [Candidate, Candidate | undefined]
	const step = runnerUp ? rank(chosen).findIndex((value, index) => value !== rank(runnerUp)[index]) : -1
	return { chosen, candidates, decidedBy: runnerUp ? STEPS[step]! : 'only candidate' }
}
