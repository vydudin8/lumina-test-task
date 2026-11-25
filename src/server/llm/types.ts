// One fact the model may use, numbered so its answer can cite it: "e1: industry = Quarrying (Apollo, 2026-11-20)".
export interface EvidenceItem {
	id: string
	label: string
	value: string
	source: string
	date: string | null
}

export const renderEvidence = (item: EvidenceItem) =>
	`${item.id}: ${item.label} = ${item.value} (${item.source}${item.date ? `, ${item.date}` : ''})`

export type RejectionCode =
	| 'invalid_json'
	| 'empty_text'
	| 'too_long'
	| 'no_citation'
	| 'unknown_citation'
	| 'uncited_number'
	| 'contains_contact_data'
	| 'api_error'
	| 'timeout'

export interface Rejection {
	code: RejectionCode
	detail: string
	// uncited_number only: the made-up numbers as the guard compared them, e.g. "120", "£44945000", "hundreds".
	values?: string[]
}

export type LlmTask = 'score_rationale' | 'card_line'

export interface LlmRequest {
	task: LlmTask
	// What the line is for, in plain words, e.g. "why Ashdown Stone fits the ICP".
	purpose: string
	evidence: EvidenceItem[]
	maxChars: number
}

export interface Llm {
	readonly model: string
	// Returns the model's raw text, which should be JSON {text, cites}. The guard decides whether it is usable.
	generate(request: LlmRequest): Promise<string>
	isRetryable(error: unknown): boolean
	isTimeout(error: unknown): boolean
}
