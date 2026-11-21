import { describe, expect, it } from 'vitest'
import { renderBack } from './mail-client.ts'

describe('renderBack', () => {
	it('fills the placeholders once and keeps replacement patterns in the line literal', () => {
		expect(
			renderBack(
				'Hi {{first_name}},\n{{personal_line}}\n{{company}}',
				'Ben',
				'Save $& and {{company}} later.',
				'Ottery Ltd',
			),
		).toBe('Hi Ben,\nSave $& and {{company}} later.\nOttery Ltd')
	})
})
