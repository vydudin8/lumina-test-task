import { retry, type RetryOptions } from '../lib/retry.ts'
import type { Logger } from '../log.ts'
import { guardOutput } from './guard.ts'
import { PROMPT_VERSIONS } from './prompts.ts'
import type { Llm, LlmRequest, Rejection } from './types.ts'

export interface GroundedLine {
	status: 'accepted' | 'rejected'
	text: string
	cites: string[]
	rejections: Rejection[]
	raw: string | null
	model: string
	promptVersion: string
}

export interface LlmDeps {
	llm: Llm
	log: Logger
	retry: RetryOptions
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Calls the model with retries, then lets the guard decide. A rejected answer is replaced by the deterministic fallback
// line, and the raw answer and the reasons are kept so the screen can say exactly why.
export async function generateGrounded(
	deps: LlmDeps,
	request: LlmRequest,
	fallback: { text: string; cites: string[] },
): Promise<GroundedLine> {
	const { llm } = deps
	const log = deps.log.child({ task: request.task, model: llm.model })
	const meta = { model: llm.model, promptVersion: PROMPT_VERSIONS[request.task] }
	const rejected = (rejections: Rejection[], raw: string | null): GroundedLine => {
		log.warn({ codes: rejections.map((rejection) => rejection.code) }, 'llm output rejected, template used')
		return { status: 'rejected', ...fallback, rejections, raw, ...meta }
	}

	let raw: string
	try {
		raw = await retry(() => llm.generate(request), {
			...deps.retry,
			maxAttempts: 3,
			isRetryable: (error) => llm.isRetryable(error) || llm.isTimeout(error),
			onRetry: ({ attempt, delayMs, error }) =>
				log.warn({ attempt, delayMs, cause: describe(error) }, 'llm call failed, retrying'),
		})
	} catch (error) {
		return rejected([{ code: llm.isTimeout(error) ? 'timeout' : 'api_error', detail: describe(error) }], null)
	}

	const result = guardOutput(raw, request.evidence, { maxChars: request.maxChars })
	if (!result.ok) return rejected(result.rejections, raw)
	log.info({ cites: result.cites.length }, 'llm output accepted')
	return { status: 'accepted', text: result.text, cites: result.cites, rejections: [], raw, ...meta }
}
