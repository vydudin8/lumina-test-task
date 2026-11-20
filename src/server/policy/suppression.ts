import { MAILED_WINDOW_DAYS } from '#common/settings.ts'
import { personKeyHash } from './person-key.ts'

export interface SuppressionState {
	optOutHashes: Set<string>
	// Latest submitted_at per person_key, across every campaign.
	lastSubmitted: Map<string, Date>
}

export type SuppressionReason = 'opt_out' | 'mailed_90d'

export function suppressionReason(personKey: string, state: SuppressionState, now: Date): SuppressionReason | null {
	if (state.optOutHashes.has(personKeyHash(personKey))) return 'opt_out'
	const last = state.lastSubmitted.get(personKey)
	if (last && now.getTime() - last.getTime() <= MAILED_WINDOW_DAYS * 86_400_000) return 'mailed_90d'
	return null
}
