import type { RunWithErrors } from '#client/components/RunStatus.tsx'
import { api } from '#client/lib/api.ts'

// One run, as its page shows it; the Providers page also watches it to tell when a pull it started has ended.
export const runQuery = (id: string) => ({
	queryKey: ['ingestion-run', id],
	queryFn: () => api<{ run: RunWithErrors }>(`/api/ingestion-runs/${id}`),
})
