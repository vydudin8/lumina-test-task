import { HttpError, parseRetryAfter } from '../../lib/retry.ts'
import type { Fetch } from '../ingest/fetch.ts'

export interface MailClient {
	baseUrl: string
	fetch: Fetch
	timeoutMs: number
}

export const RETURN_ADDRESS = {
	name: 'Lumina',
	line1: '1 Example Wharf',
	line2: null,
	city: 'London',
	postcode: 'E14 5AB',
	country: 'GB',
}

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

export const renderBack = (templateBody: string, firstName: string | null, line: string, company: string) =>
	templateBody
		.replace('{{first_name}}', firstName ?? 'there')
		.replace('{{personal_line}}', line)
		.replace('{{company}}', company)

interface CardForMail {
	id: number
	campaignId: number
	recipient: { fullName: string | null; firstName: string | null }
	address: Record<string, string | null> | null
	personalLine: string
	lineEvidence: { label: string; value: string }[]
}

// Deterministic: a retry sends byte-for-byte the same body with the same Idempotency-Key.
export function postcardBody(card: CardForMail, templateBody: string) {
	const company = card.lineEvidence.find((item) => item.label === 'company')?.value ?? ''
	const address = card.address ?? {}
	return {
		to: {
			name: card.recipient.fullName,
			line1: address.line1 ?? null,
			line2: null,
			city: address.city ?? null,
			postcode: address.postcode ?? null,
			country: address.country ?? null,
		},
		from: RETURN_ADDRESS,
		front_html: '<h1>Lumina</h1><p>Battery-electric construction machinery</p>',
		back_html: `<p>${escapeHtml(renderBack(templateBody, card.recipient.firstName, card.personalLine, company))}</p>`,
		metadata: { card_id: card.id, campaign_id: card.campaignId },
	}
}

export async function submitPostcard(
	client: MailClient,
	idempotencyKey: string,
	body: ReturnType<typeof postcardBody>,
) {
	const response = await client.fetch(`${client.baseUrl}/v1/postcards`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(client.timeoutMs),
	})
	if (!response.ok) {
		const detail = await response.text().catch(() => '')
		throw new HttpError(
			response.status,
			`mail API answered ${response.status}: ${detail.slice(0, 200)}`,
			parseRetryAfter(response.headers.get('retry-after'), new Date()),
		)
	}
	return { ...((await response.json()) as { id: string; status: string }), httpStatus: response.status }
}
