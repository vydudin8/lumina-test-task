// Domain settings shared by the server and the screens, so the UI shows the same thresholds the code applies.

export const PROVIDERS = ['apollo', 'factset', 'clay'] as const
export type ProviderName = (typeof PROVIDERS)[number]

export const PROVIDER_LABELS: Record<ProviderName, string> = { apollo: 'Apollo', factset: 'FactSet', clay: 'Clay' }

// Simulated prices: credits per record the provider returns, including records we reject.
export const CREDIT_COSTS: Record<ProviderName, { company: string; contact: string }> = {
	apollo: { company: '1', contact: '1' },
	factset: { company: '0.25', contact: '0.1' },
	clay: { company: '0.5', contact: '0.75' },
}
