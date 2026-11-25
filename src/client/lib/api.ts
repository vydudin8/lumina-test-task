export class ApiError extends Error {
	readonly status: number

	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

// Throws ApiError carrying the server's plain-language `error` message, so screens can show it as is.
export async function api<T>(path: string, { json, ...init }: RequestInit & { json?: unknown } = {}): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: json === undefined ? init.headers : { 'Content-Type': 'application/json', ...init.headers },
		body: json === undefined ? init.body : JSON.stringify(json),
	})
	if (response.status === 204) return undefined as T

	const data = (await response.json().catch(() => null)) as { error?: string } | null
	if (!response.ok) throw new ApiError(response.status, data?.error ?? `Request failed (${response.status})`)
	return data as T
}
