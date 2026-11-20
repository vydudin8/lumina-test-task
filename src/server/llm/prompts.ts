import { renderEvidence, type LlmRequest, type LlmTask } from './types.ts'

export const PROMPT_VERSIONS: Record<LlmTask, string> = { score_rationale: 'rationale-v1', card_line: 'card-line-v2' }

const RULES = `Use only the numbered evidence below. Every fact you state must come from an evidence item you cite.
Do not write any number that is not in the evidence you cite. Do not guess or round numbers.
Never include email addresses, phone numbers or web addresses.
Reply with JSON only: {"text": "...", "cites": ["e1", "e2"]}, where cites lists the evidence ids you used.`

export const SYSTEM_PROMPTS: Record<LlmTask, string> = {
	score_rationale: `You explain to a sales team, in one or two plain sentences, why a company scores the way it does against Lumina's ideal customer profile. Lumina sells battery-electric construction machinery to contractors, plant hire firms, quarries and infrastructure firms.
${RULES}`,
	card_line: `You write the personal opening line of a printed postcard from Lumina, which sells battery-electric construction machinery to contractors, plant hire firms, quarries and infrastructure firms. The postcard already greets the recipient by first name, so do not start with a greeting or their name; connect their role and company to quieter, diesel-free sites. One sentence, warm and specific, no hype.
${RULES}`,
}

export const userPrompt = (request: LlmRequest) =>
	`${request.purpose}\n\nEvidence:\n${request.evidence.map(renderEvidence).join('\n')}\n\nKeep the text under ${request.maxChars} characters.`
