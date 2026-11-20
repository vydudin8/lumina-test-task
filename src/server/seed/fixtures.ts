import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'

export const FIXTURES_DIR = `${import.meta.dirname}/../../../fixtures`

export const readFixture = <T>(path: string) => JSON.parse(readFileSync(`${FIXTURES_DIR}/${path}`, 'utf8')) as T

// Changes whenever any fixture file changes, so a database seeded from older fixtures is detected.
export function fixturesChecksum() {
	const hash = createHash('sha256')
	const files = readdirSync(FIXTURES_DIR, { recursive: true, encoding: 'utf8' })
		.filter((file) => file.endsWith('.json'))
		.sort()
	for (const file of files) hash.update(file).update(readFileSync(`${FIXTURES_DIR}/${file}`))
	return hash.digest('hex')
}

export interface History {
	optOuts: { email: string; daysAgo: number; source: string }[]
}
