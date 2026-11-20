import { pino, type DestinationStream, type Logger } from 'pino'

export type { Logger }

// Contacts are personal data: never let names, emails, phones or postal addresses reach the logs.
const PII_KEYS = [
	'email',
	'name',
	'firstName',
	'lastName',
	'fullName',
	'phone',
	'address',
	'line1',
	'line2',
	'postcode',
	'to',
]
const REDACT_PATHS = PII_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`])

export function createLogger({ level = 'info' }: { level?: string } = {}, destination?: DestinationStream): Logger {
	return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, destination)
}
