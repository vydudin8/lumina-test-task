import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { SYSTEM_PROMPTS, userPrompt } from './prompts.ts'
import type { Llm } from './types.ts'

const answerSchema = z.object({ text: z.string(), cites: z.array(z.string()) })

// Claude Haiku: short, grounded lines don't need a bigger model. Retries are ours (with jitter), so the SDK's are off.
export function createClaudeLlm({
	apiKey,
	model = 'claude-haiku-5-5',
	timeoutMs = 20_000,
	fetch,
}: {
	apiKey: string
	model?: string
	timeoutMs?: number
	fetch?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
}): Llm {
	const client = new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs, ...(fetch && { fetch }) })

	return {
		model,
		async generate(request) {
			const response = await client.messages.parse({
				model,
				max_tokens: 2000,
				system: SYSTEM_PROMPTS[request.task],
				messages: [{ role: 'user', content: userPrompt(request) }],
				output_config: { effort: 'low', format: zodOutputFormat(answerSchema) },
			})
			if (response.stop_reason === 'refusal') throw new Error('the model declined to answer')
			return response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
		},
		isRetryable: (error) =>
			error instanceof Anthropic.RateLimitError ||
			error instanceof Anthropic.InternalServerError ||
			error instanceof Anthropic.APIConnectionError,
		isTimeout: (error) => error instanceof Anthropic.APIConnectionTimeoutError,
	}
}
