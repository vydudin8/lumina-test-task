import { formatDate, formatFieldValue, formatInteger } from '#client/lib/format.ts'
import { FIELD_LABELS, PROVIDER_LABELS, type FieldName, type ProviderName } from '#common/settings.ts'

export interface AuditEvent {
	id: number
	at: string
	actorId: string
	actorRole: string
	action: string
	entityType: string
	entityId: string
	decision: string | null
	reason: string | null
	before: unknown
	after: unknown
	result: unknown
	requestId: string | null
	// Where the entry's subject lives in the app; the audit log API adds it, page activity lists do not.
	link?: string | null
}

const ACTION_LABELS: Record<string, string> = {
	'icp.saved': 'ICP saved',
	'company.merged': 'Companies merged',
	'company.unmerged': 'Record split off',
	'company.merge_undone': 'Merge undone',
	'field.overridden': 'Field value chosen',
	'card.line_edited': 'Personal line edited',
	'card.line_written': 'Personal line written',
	'card.approved': 'Card approved',
	'card.rejected': 'Card rejected',
	'card.blocked_at_send': 'Card blocked at send',
	'card.submitted': 'Card sent to print',
	'card.failed': 'Card failed to send',
	'card.send_unconfirmed': 'Card send unconfirmed',
	'card.send_retried': 'Card send retried',
	'card.status_reconciled': 'Card status checked with the printer',
	'campaign.created': 'Campaign created',
	'campaign.send_launched': 'Campaign send launched',
	'suppression.added': 'Suppression added',
	'outcome.logged': 'Outcome logged',
	'llm.output_rejected': 'AI output rejected',
}
// What each kind of entry means, for someone who did not build the system.
const ACTION_EXPLANATIONS: Record<string, string> = {
	'icp.saved':
		'A new version of the ideal customer profile was saved. Scores use the newest version unless an older one is picked; saved versions never change.',
	'company.merged':
		'Two company records were judged to be the same company and joined: their provider records and contacts now sit under one company.',
	'company.unmerged':
		'A provider record was split off into a company of its own, together with its contacts. Later pulls do not merge it back.',
	'company.merge_undone':
		'A merge was taken apart again: the provider records that came from each company went back to it, under its old number. Later pulls do not merge them back.',
	'field.overridden':
		"A person chose which provider's value this company uses for a field. The choice stays in place after future pulls.",
	'card.line_edited':
		'The personal line on a postcard was rewritten. An approved card goes back to draft and needs approving again.',
	'card.line_written':
		'The personal line was filled in by the AI, or by the template when the AI text failed the checks. A person can still rewrite it.',
	'card.approved': 'A sales lead approved the postcard, so it goes out when the campaign is sent.',
	'card.rejected': 'The postcard was rejected and will not be sent.',
	'card.blocked_at_send':
		'A last check just before sending stopped this postcard, for example because the person had opted out or was mailed recently.',
	'card.submitted': 'The postcard was handed to the print-and-mail service, which gave it a mail id.',
	'card.failed': 'The print-and-mail service refused the postcard, so it was not sent.',
	'card.send_unconfirmed':
		'The print-and-mail service gave no clear answer, or the send broke on our side, so it is not known whether it took the postcard. Retrying is safe: the same idempotency key stops a second print.',
	'card.send_retried':
		'An unconfirmed postcard was queued again. Its idempotency key makes sure it is printed at most once.',
	'card.status_reconciled':
		'No status update had arrived from the print-and-mail service for a while, so the system asked it directly and caught up.',
	'campaign.created':
		'A campaign was built from the top companies by score, one draft postcard per company. Cards that cannot go out are marked blocked with the reason.',
	'campaign.send_launched': 'A sales lead launched the send: every approved postcard was queued for printing.',
	'suppression.added': 'This person was put on the suppression list and gets no postcards.',
	'outcome.logged': 'A result was recorded for a sent postcard, such as a reply, a website visit or a meeting.',
	'llm.output_rejected':
		'Text the AI wrote failed the checks (for example a figure it could not cite), so it was not used and a template took its place.',
}
const ENTITY_LABELS: Record<string, string> = { icp_version: 'ICP version' }
const LLM_TASKS: Record<string, string> = { score_rationale: 'score rationale', card_line: 'personal line' }

// Unknown codes fall through as they are: a new action still shows, just less politely.
export const actionLabel = (action: string) => ACTION_LABELS[action] ?? action
export const entityLabel = (type: string) => ENTITY_LABELS[type] ?? type
export const actionExplanation = (action: string) => ACTION_EXPLANATIONS[action] ?? null

const record = (value: unknown) => (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
// Audit payloads are JSON written by the server; anything that is not a plain string or number shows as nothing.
const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const plural = (count: number, word: string) => `${formatInteger(count)} ${word}${count === 1 ? '' : 's'}`
const words = (code: unknown) => text(code).replaceAll('_', ' ')
// "apollo:AP-1" -> "Apollo record AP-1"
const sourceRecord = (label: unknown) => {
	const [provider = '', ...id] = text(label).split(':')
	return `${PROVIDER_LABELS[provider as ProviderName] ?? provider} record ${id.join(':')}`
}
const fieldChoice = (field: string, value: unknown) => {
	const { value: picked, provider } = record(value)
	const from = provider ? ` (${PROVIDER_LABELS[provider as ProviderName] ?? text(provider)})` : ''
	return `${formatFieldValue(field, picked)}${from}`
}

// What happened in one line of plain words. The full before/after stays one click away (diffRows).
export function describeEvent(event: Pick<AuditEvent, 'action' | 'before' | 'after' | 'result'>) {
	const before = record(event.before)
	const after = record(event.after)
	const result = record(event.result)
	const parts: string[] = []
	if (typeof before.status === 'string' && typeof after.status === 'string' && before.status !== after.status)
		parts.push(`${words(before.status)} → ${words(after.status)}`)

	switch (event.action) {
		case 'field.overridden': {
			const field = Object.keys(after)[0]
			if (field)
				parts.push(
					`${FIELD_LABELS[field as FieldName] ?? field}: ${fieldChoice(field, before[field])} → ${fieldChoice(field, after[field])}`,
				)
			break
		}
		case 'company.merged':
			parts.push(
				`${list(before.companies)
					.map((id) => `#${text(id)}`)
					.join(' and ')} became company #${text(after.company)}`,
				plural(list(result.records).length, 'provider record'),
			)
			break
		case 'company.unmerged':
			parts.push(`${sourceRecord(result.record)} became company #${text(result.company)}`)
			break
		case 'company.merge_undone':
			parts.push(
				`#${text(before.company)} became companies ${list(after.companies)
					.map((id) => `#${text(id)}`)
					.join(' and ')}`,
				plural(list(result.records).length, 'provider record'),
			)
			break
		case 'icp.saved': {
			const counts = (['added', 'removed', 'changed'] as const)
				.filter((kind) => list(result[kind]).length)
				.map((kind) => `${plural(list(result[kind]).length, 'rule')} ${kind}`)
			parts.push(`version ${text(before.version)} → ${text(after.version)}`, counts.join(', ') || 'no rule changes')
			break
		}
		case 'card.line_edited':
			parts.push(`“${text(before.personalLine)}” → “${text(after.personalLine)}”`)
			break
		case 'card.line_written':
			parts.push(after.lineSource === 'llm' ? 'written by the AI' : 'template line')
			break
		case 'card.approved':
			if (result.bulk) parts.push('bulk approval')
			break
		case 'card.send_retried':
			if (result.bulk) parts.push('bulk retry')
			break
		case 'card.submitted':
			parts.push(`mail id ${text(result.mail_id)}`, plural(Number(result.attempts), 'attempt'))
			break
		case 'card.failed':
		case 'card.send_unconfirmed':
			// A send that broke on our side has no count of attempts, only its error.
			parts.push(result.attempts === undefined ? 'error on our side' : plural(Number(result.attempts), 'attempt'))
			break
		case 'campaign.created':
			parts.push(
				`“${text(after.name)}”, top ${text(after.topN)}`,
				`${plural(Number(result.cards), 'card')}, ${formatInteger(Number(result.eligible))} eligible`,
			)
			break
		case 'campaign.send_launched':
			parts.push(`${plural(Number(result.cards_queued), 'card')} queued`)
			break
		case 'suppression.added':
			parts.push(`source: ${words(result.source)}`)
			break
		case 'outcome.logged':
			parts.push(`${words(after.kind)} on ${formatDate(text(after.occurredAt) || null)}`)
			break
		case 'llm.output_rejected':
			parts.push(`${LLM_TASKS[text(result.task)] ?? words(result.task)} from ${text(result.model)}`)
			break
	}
	return parts.join(' · ')
}

const hasId = (item: unknown) => ['string', 'number'].includes(typeof record(item).id)

// Nested objects become dotted paths ("headcount.value"), so a diff points at the value that moved.
// Lists of things with ids (ICP rules) go by id, so adding one rule does not shift the rest; other lists stay whole.
export function flatten(value: unknown, path = ''): [string, unknown][] {
	if (Array.isArray(value) && value.length > 0 && value.every(hasId))
		return value.flatMap((item) => flatten(item, `${path}[${text(record(item).id)}]`))
	if (value !== null && typeof value === 'object' && !Array.isArray(value))
		return Object.entries(value).flatMap(([key, inner]) => flatten(inner, path ? `${path}.${key}` : key))
	return [[path || 'value', value]]
}

export function diffRows(before: unknown, after: unknown) {
	const from = new Map(before == null ? [] : flatten(before))
	const to = new Map(after == null ? [] : flatten(after))
	return [...new Set([...from.keys(), ...to.keys()])].map((path) => ({
		path,
		before: from.get(path),
		after: to.get(path),
		changed: JSON.stringify(from.get(path)) !== JSON.stringify(to.get(path)),
	}))
}
