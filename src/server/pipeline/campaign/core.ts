import { PROVIDER_LABELS, SIGNAL_LABELS, type ProviderName } from '#common/settings.ts'
import type { EvidenceItem } from '../../llm/types.ts'
import { validateAddress } from '../../policy/address.ts'
import type { Candidate } from '../../policy/recipient.ts'
import { suppressionReason, type SuppressionState } from '../../policy/suppression.ts'
import type { Address, ResolvedFields } from '../resolve/core.ts'

const integer = new Intl.NumberFormat('en-GB')
const label = (provider: string | null) =>
	provider ? (PROVIDER_LABELS[provider as ProviderName] ?? provider) : 'no provider'

// Only first name, title and company facts reach the model: no email, no address, no surname.
export function cardLineEvidence(recipient: Candidate | null, company: { fields: ResolvedFields }): EvidenceItem[] {
	const { fields } = company
	const recipientSource = recipient?.providers.map(label).join(', ') ?? ''
	const items: Omit<EvidenceItem, 'id'>[] = []
	if (recipient?.firstName)
		items.push({ label: 'first name', value: recipient.firstName, source: recipientSource, date: null })
	if (recipient?.title) items.push({ label: 'title', value: recipient.title, source: recipientSource, date: null })
	items.push({
		label: 'company',
		value: fields.name.value ?? 'your company',
		source: label(fields.name.provider),
		date: null,
	})
	if (fields.industry.value)
		items.push({
			label: 'industry',
			value: fields.industry.value,
			source: label(fields.industry.provider),
			date: fields.industry.asOf,
		})
	if (fields.headcount.value !== null) {
		items.push({
			label: 'headcount',
			value: integer.format(fields.headcount.value),
			source: label(fields.headcount.provider),
			date: fields.headcount.asOf,
		})
	}
	if (fields.signals.value?.length) {
		items.push({
			label: 'signals',
			value: fields.signals.value.map((signal) => SIGNAL_LABELS[signal] ?? signal).join('; '),
			source: 'providers',
			date: null,
		})
	}
	return items.map((item, index) => ({ id: `e${index + 1}`, ...item }))
}

// The template greets by first name, so the line itself does not.
export function fallbackLine(evidence: EvidenceItem[]) {
	const company = evidence.find((item) => item.label === 'company')!
	return {
		text: `Battery-electric machines from Lumina could help ${company.value} run quieter, diesel-free sites.`,
		cites: [company.id],
	}
}

// Suppression first, then the address: the first problem found is the one the card shows.
export function blockReason(personKey: string, address: Address | null, suppression: SuppressionState, now: Date) {
	const suppressed = suppressionReason(personKey, suppression, now)
	if (suppressed) return `suppressed:${suppressed}`
	const valid = validateAddress(address)
	return valid.ok ? null : `invalid_address:${valid.reason}`
}
