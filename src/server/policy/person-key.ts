import { createHash } from 'node:crypto'

// A person is identified by their normalised work email across providers, suppressions and past mailings.
export const personKey = (email: string) => email.trim().toLowerCase()

export const personKeyHash = (key: string) => createHash('sha256').update(key).digest('hex')
