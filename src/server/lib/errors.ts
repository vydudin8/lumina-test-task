import { HttpError } from './retry.ts'

// A rule the user broke (bad input, missing reason, wrong state). The HTTP layer returns its message as is.
export class DomainError extends Error {
	readonly status: 400 | 403 | 404 | 409

	constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
		super(message)
		this.name = 'DomainError'
		this.status = status
	}
}

const ERROR_MAX_CHARS = 300

// Stored where the screens show it, so it carries the kind of failure and nothing a row might hold: a database error's
// text repeats the query and its values, and those can be a person's name or address.
export function failureText(error: unknown) {
	if (error instanceof HttpError || error instanceof DomainError) return error.message.slice(0, ERROR_MAX_CHARS)
	if (!(error instanceof Error)) return 'Unknown error'
	const { code, constraint } = (error.cause ?? {}) as { code?: string; constraint?: string }
	return [error.name, code, constraint].filter(Boolean).join(' ')
}
