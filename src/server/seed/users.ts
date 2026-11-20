import type { User } from '#common/schemas.ts'
import type { Executor } from '../db/client.ts'
import { users } from '../db/schema.ts'

export const SEED_USERS: User[] = [
	{ id: 'usr_lead_maya', name: 'Maya Fernandes', role: 'lead' },
	{ id: 'usr_rep_tom', name: 'Tom Okafor', role: 'rep' },
	{ id: 'usr_rep_ana', name: 'Ana Kowalski', role: 'rep' },
]

export async function seedUsers(executor: Executor) {
	await executor.insert(users).values(SEED_USERS).onConflictDoNothing({ target: users.id })
}
