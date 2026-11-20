const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' })
const integer = new Intl.NumberFormat('en-GB')

export const formatDateTime = (value: string | null) => (value ? dateTime.format(new Date(value)) : '—')
export const formatDate = (value: string | null) => (value ? date.format(new Date(value)) : '—')
export const formatInteger = (value: number) => integer.format(value)

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 })

// Decimal strings go to Intl as strings, so no float rounding happens on the way to the screen.
export const formatGbp = (value: string | null) => (value === null ? '—' : gbp.format(value as unknown as number))

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
