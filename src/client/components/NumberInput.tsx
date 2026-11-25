import { Input } from '#client/components/ui/input.tsx'
import { cleanNumber, stepNumber } from '#client/lib/number-input.ts'
import type { ComponentProps } from 'react'

// A text field that only ever holds a non-negative number: anything else typed or pasted is dropped as it arrives.
export function NumberInput({
	value,
	onValueChange,
	decimal = false,
	max,
	onKeyDown,
	...props
}: {
	value: string
	onValueChange: (value: string) => void
	decimal?: boolean
	max?: number
} & Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type' | 'inputMode'>) {
	return (
		<Input
			type="text"
			inputMode={decimal ? 'decimal' : 'numeric'}
			autoComplete="off"
			value={value}
			onChange={(event) => onValueChange(cleanNumber(event.target.value, { decimal, max }))}
			onKeyDown={(event) => {
				onKeyDown?.(event)
				const delta = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0
				if (!delta || event.defaultPrevented) return
				// Keeps the caret from jumping to the start or end of the text.
				event.preventDefault()
				onValueChange(stepNumber(value, delta, { decimal, max }))
			}}
			{...props}
		/>
	)
}
