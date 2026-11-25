import { SIGNAL_LABELS } from '#common/settings.ts'

const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' })
const time = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' })
const integer = new Intl.NumberFormat('en-GB')

export const formatDateTime = (value: string | null) => (value ? dateTime.format(new Date(value)) : '—')
export const formatDate = (value: string | null) => (value ? date.format(new Date(value)) : '—')
export const formatTime = (value: string) => time.format(new Date(value))
export const formatInteger = (value: number) => integer.format(value)

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 })

// Decimal strings go to Intl as strings, so no float rounding happens on the way to the screen.
export const formatGbp = (value: string | null) => (value === null ? '—' : gbp.format(value as unknown as number))

const twoPlaces = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 })
export const formatDecimal = (value: string) => twoPlaces.format(value as unknown as number)

const gbpShort = new Intl.NumberFormat('en-GB', {
	style: 'currency',
	currency: 'GBP',
	notation: 'compact',
	maximumFractionDigits: 1,
})
// "£2.5M": for slider thresholds and other places where the exact figure is not the point.
export const formatGbpShort = (value: number) => gbpShort.format(value)

export const formatMoney = (amount: string, currency: string) =>
	new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(
		amount as unknown as number,
	)

export interface AddressValue {
	line1: string | null
	city: string | null
	region: string | null
	postcode: string | null
	country: string | null
}

export const formatAddress = (address: AddressValue | null) =>
	address
		? [address.line1, address.city, address.region, address.postcode, address.country].filter(Boolean).join(', ')
		: '—'

// A company field value as plain text, for places outside the field table (the audit log, for one).
export function formatFieldValue(field: string, value: unknown): string {
	if (value === null || value === undefined) return 'unknown'
	if (field === 'headcount') return formatInteger(value as number)
	if (field === 'revenue') return formatGbp((value as { gbp: string }).gbp)
	if (field === 'address') return formatAddress(value as AddressValue)
	if (field === 'signals') return (value as string[]).map((signal) => SIGNAL_LABELS[signal] ?? signal).join(', ')
	return typeof value === 'string' ? value : JSON.stringify(value)
}
