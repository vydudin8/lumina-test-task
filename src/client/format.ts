const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' })
const integer = new Intl.NumberFormat('en-GB')

export const formatDateTime = (value: string | null) => (value ? dateTime.format(new Date(value)) : '—')
export const formatDate = (value: string | null) => (value ? date.format(new Date(value)) : '—')
export const formatInteger = (value: number) => integer.format(value)
