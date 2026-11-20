import { createHash } from 'node:crypto'
import type { EvidenceItem, Llm, LlmRequest } from './types.ts'

// Deterministic stand-in for Claude, used when there is no API key and always in tests. It writes from the evidence,
// and every `hallucinateEvery`-th request (by a hash of the input) invents a number, so the guard has work to do.
export function createStubLlm({ hallucinateEvery = 9 }: { hallucinateEvery?: number } = {}): Llm {
	return {
		model: 'stub-v1',
		generate(request: LlmRequest) {
			const find = (label: string) => request.evidence.find((item) => item.label === label)
			const used: EvidenceItem[] = []
			const take = (label: string) => {
				const item = find(label)
				if (item) used.push(item)
				return item?.value
			}

			let text: string
			if (request.task === 'card_line') {
				const name = take('first name') ?? 'there'
				const company = take('company') ?? 'your team'
				const title = take('title')
				const industry = take('industry')
				text = `${name}, ${title ? `as ${title} at ${company}` : `at ${company}`}, you could run ${industry ? `${industry.toLowerCase()} ` : ''}sites quieter and without diesel deliveries.`
			} else {
				const industry = take('industry')
				const headcount = take('headcount')
				const revenue = take('revenue')
				const parts = [
					industry && `works in ${industry.toLowerCase()}`,
					headcount && `has ${headcount} staff`,
					revenue && `reports revenue of ${revenue}`,
				].filter(Boolean)
				text = `${take('company') ?? 'This company'} ${parts.length ? parts.join(', ') : 'has little data on file'}.`
			}

			const hash = parseInt(createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 8), 16)
			if (hallucinateEvery > 0 && hash % hallucinateEvery === 0) text = text.replace(/\.$/, ', across 120 sites.')

			return Promise.resolve(JSON.stringify({ text, cites: used.map((item) => item.id) }))
		},
		isRetryable: () => false,
		isTimeout: () => false,
	}
}
