import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger } from './log.ts'

function capture() {
	const lines: Record<string, unknown>[] = []
	const stream = new Writable({
		write(chunk: Buffer, _encoding, done) {
			lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
			done()
		},
	})
	return { lines, logger: createLogger({ level: 'info' }, stream) }
}

describe('createLogger', () => {
	it('writes JSON lines', () => {
		const { lines, logger } = capture()
		logger.info({ runId: 7 }, 'ingestion started')
		expect(lines[0]).toMatchObject({ level: 30, runId: 7, msg: 'ingestion started' })
	})

	it('redacts emails, names and addresses at any of the first three levels', () => {
		const { lines, logger } = capture()
		logger.info(
			{
				email: 'a@b.com',
				contact: { name: 'Jo Bloggs', email: 'jo@acme.co.uk', phone: '+44 20 0000 0000', title: 'COO' },
				request: { to: { name: 'Jo Bloggs', line1: '1 High St', postcode: 'SW1A 1AA' } },
			},
			'submitting card',
		)
		expect(lines[0]).toMatchObject({
			email: '[redacted]',
			contact: { name: '[redacted]', email: '[redacted]', phone: '[redacted]', title: 'COO' },
			request: { to: '[redacted]' },
		})
	})
})
