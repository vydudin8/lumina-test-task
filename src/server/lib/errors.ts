// A rule the user broke (bad input, missing reason, wrong state). The HTTP layer returns its message as is.
export class DomainError extends Error {
	readonly status: 400 | 403 | 404 | 409

	constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
		super(message)
		this.name = 'DomainError'
		this.status = status
	}
}
