import { z } from 'zod'
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

// One pass with a replacer function: "$&" in a line stays literal, and a placeholder inside a value is not expanded.
export const renderBack = (templateBody: string, firstName: string | null, line: string, company: string) => {
	const values: Record<string, string> = { first_name: firstName ?? 'there', personal_line: line, company }
	return templateBody.replace(/\{\{(first_name|personal_line|company)\}\}/g, (_, key: string) => values[key]!)
}

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
	await throwUnlessOk(response)
	return { ...((await response.json()) as { id: string; status: string }), httpStatus: response.status }
}

async function throwUnlessOk(response: Response) {
	if (response.ok) return
	const detail = await response.text().catch(() => '')
	throw new HttpError(
		response.status,
		`mail API answered ${response.status}: ${detail.slice(0, 200)}`,
		parseRetryAfter(response.headers.get('retry-after'), new Date()),
	)
}

export const MAIL_STATUSES = ['submitted', 'printed', 'mailed', 'delivered', 'returned'] as const
export type MailStatus = (typeof MAIL_STATUSES)[number]

const postcardSchema = z.object({
	id: z.string().min(1),
	status: z.enum(MAIL_STATUSES),
	events: z.array(
		z.object({
			event_id: z.string().min(1),
			status: z.enum(MAIL_STATUSES),
			occurred_at: z.iso.datetime({ offset: true }),
		}),
	),
})

// What the provider says happened to a postcard so far: the same events its webhooks carry.
export async function getPostcard(client: MailClient, mailId: string) {
	const response = await client.fetch(`${client.baseUrl}/v1/postcards/${encodeURIComponent(mailId)}`, {
		signal: AbortSignal.timeout(client.timeoutMs),
	})
	await throwUnlessOk(response)
	return postcardSchema.parse(await response.json())
}
