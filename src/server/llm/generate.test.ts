import { describe, expect, it } from 'vitest'
import { HttpError } from '../lib/retry.ts'
import { createLogger } from '../log.ts'
import { createClaudeLlm } from './claude.ts'
import { generateGrounded } from './generate.ts'
import { createStubLlm } from './stub.ts'
import type { EvidenceItem, Llm, LlmRequest } from './types.ts'

const evidence: EvidenceItem[] = [
	{ id: 'e1', label: 'company', value: 'Ashdown Stone', source: 'Apollo', date: null },
	{ id: 'e2', label: 'industry', value: 'Quarrying', source: 'Apollo', date: null },
	{ id: 'e3', label: 'headcount', value: '1,186', source: 'FactSet', date: '2026-03-31' },
]
const request: LlmRequest = { task: 'score_rationale', purpose: 'Why Ashdown Stone fits', evidence, maxChars: 300 }
const fallback = { text: 'Ashdown Stone is in Quarrying.', cites: ['e1', 'e2'] }
const deps = (llm: Llm) => ({
	llm,
	log: createLogger({ level: 'silent' }),
	retry: { rng: () => 0, sleep: () => Promise.resolve() },
})

function fakeLlm(responses: (string | Error)[]): Llm & { calls: number } {
	const llm = {
		model: 'fake',
		calls: 0,
		generate: () => {
			const next = responses[Math.min(llm.calls++, responses.length - 1)]!
			return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
		},
		isRetryable: (error: unknown) => error instanceof HttpError,
		isTimeout: (error: unknown) => error instanceof Error && error.name === 'TimeoutError',
	}
	return llm
}

describe('generateGrounded', () => {
	it('keeps a grounded answer with its citations, model and prompt version', async () => {
		const line = await generateGrounded(
			deps(fakeLlm([JSON.stringify({ text: 'Quarrying firm with 1,186 staff.', cites: ['e2', 'e3'] })])),
			request,
			fallback,
		)
		expect(line).toMatchObject({
			status: 'accepted',
			text: 'Quarrying firm with 1,186 staff.',
			cites: ['e2', 'e3'],
			rejections: [],
			model: 'fake',
			promptVersion: 'rationale-v1',
		})
	})

	it('falls back to the template and keeps the raw answer and the reasons when the guard rejects it', async () => {
		const raw = JSON.stringify({ text: 'Runs 120 quarries.', cites: ['e2'] })
		const line = await generateGrounded(deps(fakeLlm([raw])), request, fallback)
		expect(line).toMatchObject({
			status: 'rejected',
			text: fallback.text,
			cites: fallback.cites,
			raw,
			rejections: [{ code: 'uncited_number' }],
		})
	})

	it('retries a transient API error, then succeeds', async () => {
		const llm = fakeLlm([new HttpError(529, 'overloaded'), JSON.stringify({ text: 'Quarrying firm.', cites: ['e2'] })])
		expect((await generateGrounded(deps(llm), request, fallback)).status).toBe('accepted')
		expect(llm.calls).toBe(2)
	})

	it('records api_error after the retries run out, and timeout for a timeout', async () => {
		const failing = fakeLlm([new HttpError(500, 'down')])
		expect(await generateGrounded(deps(failing), request, fallback)).toMatchObject({
			status: 'rejected',
			raw: null,
			rejections: [{ code: 'api_error' }],
		})
		expect(failing.calls).toBe(3)

		const slow = fakeLlm([Object.assign(new Error('timed out'), { name: 'TimeoutError' })])
		expect(await generateGrounded(deps(slow), request, fallback)).toMatchObject({ rejections: [{ code: 'timeout' }] })
	})
})

describe('stub LLM', () => {
	it('answers deterministically from the evidence, so tests and demos never need a key', async () => {
		const llm = createStubLlm({ hallucinateEvery: 0 })
		const first = await llm.generate(request)
		expect(await llm.generate(request)).toBe(first)
		expect((await generateGrounded(deps(llm), request, fallback)).status).toBe('accepted')
	})

	it('can be made to invent a number, to show what a rejection looks like', async () => {
		const line = await generateGrounded(deps(createStubLlm({ hallucinateEvery: 1 })), request, fallback)
		expect(line).toMatchObject({
			status: 'rejected',
			rejections: [{ code: 'uncited_number', detail: "number '120' is not in the evidence" }],
		})
	})
})

describe('Claude LLM', () => {
	it('asks Claude Haiku for JSON with the evidence in the prompt and returns the raw text', async () => {
		let body: Record<string, unknown> = {}
		const llm = createClaudeLlm({
			apiKey: 'test-key',
			fetch: (_url, init) => {
				body = JSON.parse(init?.body as string) as Record<string, unknown>
				return Promise.resolve(
					Response.json({
						id: 'msg_1',
						type: 'message',
						role: 'assistant',
						model: 'claude-haiku-5-5',
						content: [{ type: 'text', text: '{"text":"Quarrying firm.","cites":["e2"]}' }],
						stop_reason: 'end_turn',
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 5 },
					}),
				)
			},
		})
		expect(await llm.generate(request)).toBe('{"text":"Quarrying firm.","cites":["e2"]}')
		expect(body).toMatchObject({ model: 'claude-haiku-5-5', output_config: { format: { type: 'json_schema' } } })
		expect(JSON.stringify(body.messages)).toContain('e3: headcount = 1,186 (FactSet, 2026-03-31)')
	})

	it('treats 429 and 5xx as retryable and 400 as final', async () => {
		const llm = createClaudeLlm({
			apiKey: 'test-key',
			fetch: () =>
				Promise.resolve(
					Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429 }),
				),
		})
		const error = await llm.generate(request).catch((caught: unknown) => caught)
		expect(llm.isRetryable(error)).toBe(true)

		const bad = createClaudeLlm({
			apiKey: 'test-key',
			fetch: () =>
				Promise.resolve(
					Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'no' } }, { status: 400 }),
				),
		})
		expect(bad.isRetryable(await bad.generate(request).catch((caught: unknown) => caught))).toBe(false)
	})
})
