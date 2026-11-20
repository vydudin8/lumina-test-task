import { api } from '#client/api.ts'
import { QueryState } from '#client/components/QueryState.tsx'
import { Badge } from '#client/components/ui/badge.tsx'
import { Input } from '#client/components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#client/components/ui/select.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { formatGbp, formatInteger } from '#client/format.ts'
import {
	CONFLICT_RELATIVE_DIFFERENCE,
	FIELD_LABELS,
	PROVIDER_LABELS,
	STALE_AFTER_MONTHS,
	type FieldName,
	type ProviderName,
} from '#common/settings.ts'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'

interface CompanyRow {
	id: number
	name: string | null
	domain: string | null
	country: string | null
	industry: string | null
	headcount: number | null
	revenueGbp: string | null
	providers: ProviderName[]
	conflicts: FieldName[]
	stale: FieldName[]
	overridden: FieldName[]
	contactCount: number
}

interface Summary {
	companies: number
	sources: number
	conflicts: Record<FieldName, number>
	stale: number
	possibleDuplicates: number
}

const FILTERS: [string, string][] = [
	['all', 'All companies'],
	['conflicts', 'Providers disagree'],
	['conflict:headcount', 'Headcount conflicts'],
	['stale', 'Stale values'],
	['duplicates', 'Possible duplicates'],
	['overridden', 'Changed by a person'],
	['multi-source', 'In more than one provider'],
]

export function CompaniesPage() {
	const [params, setParams] = useSearchParams()
	const filter = params.get('filter') ?? 'all'
	const q = params.get('q') ?? ''
	const search = new URLSearchParams({ ...(filter !== 'all' && { filter }), ...(q && { q }) }).toString()
	const query = useQuery({
		queryKey: ['companies', search],
		queryFn: () => api<{ companies: CompanyRow[]; summary: Summary }>(`/api/companies?${search}`),
	})
	const setFilter = (next: string) =>
		setParams((current) => {
			const updated = new URLSearchParams(current)
			if (next === 'all') updated.delete('filter')
			else updated.set('filter', next)
			return updated
		})

	return (
		<div className="space-y-6">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold">Companies</h1>
				<p className="max-w-3xl text-muted-foreground">
					One row per real company, merged from the provider records. Providers disagree when headcount or revenue
					differ by more than {Number(CONFLICT_RELATIVE_DIFFERENCE) * 100}%, or when industry, country or address differ
					at all. A value is stale when the provider's own date is more than {STALE_AFTER_MONTHS} months old.
				</p>
			</div>

			<QueryState query={query}>
				{({ summary }) => (
					<p className="text-sm">
						{formatInteger(summary.companies)} companies from {formatInteger(summary.sources)} provider records ·{' '}
						<button
							type="button"
							className="underline underline-offset-2"
							onClick={() => setFilter('conflict:headcount')}
						>
							{summary.conflicts.headcount} headcount conflicts
						</button>{' '}
						·{' '}
						<button type="button" className="underline underline-offset-2" onClick={() => setFilter('stale')}>
							{summary.stale} with stale values
						</button>{' '}
						·{' '}
						<button type="button" className="underline underline-offset-2" onClick={() => setFilter('duplicates')}>
							{summary.possibleDuplicates} possible duplicates to check
						</button>
					</p>
				)}
			</QueryState>

			<div className="flex flex-wrap gap-2">
				<Input
					aria-label="Search companies"
					placeholder="Search name or domain"
					className="w-72"
					defaultValue={q}
					onKeyDown={(event) => {
						if (event.key !== 'Enter') return
						const value = event.currentTarget.value
						setParams((current) => {
							const updated = new URLSearchParams(current)
							if (value) updated.set('q', value)
							else updated.delete('q')
							return updated
						})
					}}
				/>
				<Select value={filter} onValueChange={setFilter}>
					<SelectTrigger aria-label="Filter" className="w-60">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{FILTERS.map(([value, label]) => (
							<SelectItem key={value} value={value}>
								{label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<QueryState query={query} empty="No companies match." isEmpty={(data) => data.companies.length === 0}>
				{({ companies }) => (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Company</TableHead>
								<TableHead>Country</TableHead>
								<TableHead>Industry</TableHead>
								<TableHead className="text-right">Headcount</TableHead>
								<TableHead className="text-right">Revenue</TableHead>
								<TableHead>Sources</TableHead>
								<TableHead>Flags</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{companies.map((company) => (
								<TableRow key={company.id}>
									<TableCell>
										<Link to={`/companies/${company.id}`} className="font-medium underline-offset-2 hover:underline">
											{company.name ?? 'Unnamed'}
										</Link>
										<div className="text-xs text-muted-foreground">{company.domain ?? 'no domain'}</div>
									</TableCell>
									<TableCell>{company.country ?? 'unknown'}</TableCell>
									<TableCell>{company.industry ?? <span className="text-muted-foreground">unknown</span>}</TableCell>
									<TableCell className="text-right tabular-nums">
										{company.headcount === null ? '—' : formatInteger(company.headcount)}
									</TableCell>
									<TableCell className="text-right tabular-nums">{formatGbp(company.revenueGbp)}</TableCell>
									<TableCell className="space-x-1">
										{company.providers.map((provider) => (
											<Badge key={provider} variant="outline">
												{PROVIDER_LABELS[provider]}
											</Badge>
										))}
									</TableCell>
									<TableCell className="space-x-1">
										{company.conflicts.map((field) => (
											<Badge key={`c-${field}`} variant="destructive">
												{FIELD_LABELS[field]} conflict
											</Badge>
										))}
										{company.stale.map((field) => (
											<Badge key={`s-${field}`} variant="secondary">
												{FIELD_LABELS[field]} stale
											</Badge>
										))}
										{company.overridden.map((field) => (
											<Badge key={`o-${field}`} variant="outline">
												{FIELD_LABELS[field]} set by a person
											</Badge>
										))}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</QueryState>
		</div>
	)
}
