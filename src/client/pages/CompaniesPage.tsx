import { DomainLink } from '#client/components/DomainLink.tsx'
import { FilterBar, FilterMultiSelect, FilterRange, FilterSelect } from '#client/components/Filters.tsx'
import { Pager } from '#client/components/Pager.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { Badge } from '#client/components/ui/badge.tsx'
import { Table, TableBody, TableCell, TableHeader, TableRow, TableSortHead } from '#client/components/ui/table.tsx'
import { api } from '#client/lib/api.ts'
import { countryName } from '#client/lib/countries.ts'
import { formatGbp, formatGbpShort, formatInteger } from '#client/lib/format.ts'
import { nextSort, useCursorPages, useFilterParams } from '#client/lib/lists.ts'
import { cn } from '#client/lib/utils.ts'
import {
	CONFLICT_RELATIVE_DIFFERENCE,
	FIELD_LABELS,
	PROVIDER_LABELS,
	PROVIDERS,
	STALE_AFTER_MONTHS,
	type FieldName,
	type ProviderName,
} from '#common/settings.ts'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

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
	['conflicts', 'Providers disagree'],
	['conflict:headcount', 'Headcount conflicts'],
	['conflict:address', 'Address conflicts'],
	['stale', 'Stale values'],
	['duplicates', 'Possible duplicates'],
	['overridden', 'Changed by a person'],
	['multi-source', 'In more than one provider'],
]

const LIST_FILTERS = [
	'q',
	'filter',
	'country',
	'industry',
	'source',
	'headcountMin',
	'headcountMax',
	'revenueMin',
	'revenueMax',
] as const

// [sort key, header, first direction, width]: numbers start with the biggest, text with A.
// Fixed widths (the longest value and some room), so paging, sorting and filtering never move the columns.
// Flags takes the rest.
const COLUMNS = [
	['name', 'Company', 'asc', 'w-72'],
	['country', 'Country', 'asc', 'w-36'],
	['industry', 'Industry', 'asc', 'w-36'],
	['headcount', 'Headcount', 'desc', 'w-28'],
	['revenue', 'Revenue', 'desc', 'w-32'],
	['sources', 'Sources', 'desc', 'w-40'],
	['flags', 'Flags', 'desc', ''],
] as const

const HEADCOUNT_STOPS = [0, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
// Whole pounds; the slider only picks thresholds, the comparison itself happens in decimals on the server.
const REVENUE_STOPS = [0, 1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7, 1e8, 2.5e8, 5e8]

interface CompaniesResponse {
	total: number
	pageSize: number
	nextCursor: string | null
	companies: CompanyRow[]
	facets: { countries: string[]; industries: string[] }
	summary: Summary
}

// A flag opens the company at that field's row.
function FlagLink({
	companyId,
	field,
	variant,
	children,
}: {
	companyId: number
	field: FieldName
	variant: 'destructive' | 'secondary' | 'outline'
	children: ReactNode
}) {
	return (
		<Badge asChild variant={variant}>
			<Link to={`/companies/${companyId}#field-${field}`}>{children}</Link>
		</Badge>
	)
}

// A value opens the company at that field's row, in plain text colour so the table stays calm.
function ValueLink({ companyId, field, children }: { companyId: number; field: FieldName; children: ReactNode }) {
	return (
		<Link to={`/companies/${companyId}#field-${field}`} className="link text-foreground">
			{children}
		</Link>
	)
}

export function CompaniesPage() {
	const [params, update] = useFilterParams()
	const get = (key: string) => params.get(key) ?? ''
	const many = (key: string) => get(key).split(',').filter(Boolean)
	const filter = get('filter')
	const sort = get('sort') || 'name'
	const dir = get('dir') || 'asc'

	const filters = new URLSearchParams()
	for (const key of [...LIST_FILTERS, 'sort', 'dir']) if (params.get(key)) filters.set(key, params.get(key)!)
	// Any change to the filters or the sort starts again from page one.
	const pages = useCursorPages('companies', filters.toString())
	const search = new URLSearchParams(filters)
	if (pages.cursor) search.set('cursor', pages.cursor)
	const query = useQuery({
		queryKey: ['companies', search.toString()],
		queryFn: () => api<CompaniesResponse>(`/api/companies?${search.toString()}`),
		placeholderData: keepPreviousData,
	})
	const setFilter = (next: string) => update({ filter: next })
	const cleared = Object.fromEntries(LIST_FILTERS.map((key) => [key, '']))
	// A summary link shows everything it counts, so it clears the other filters.
	const showOnly = (next: string) => update({ ...cleared, filter: next })
	const bounds = (min: string, max: string): [number | null, number | null] => [
		get(min) ? Number(get(min)) : null,
		get(max) ? Number(get(max)) : null,
	]
	const setBounds = (min: string, max: string) => (value: [number | null, number | null]) =>
		update({ [min]: value[0] === null ? '' : String(value[0]), [max]: value[1] === null ? '' : String(value[1]) })
	const facets = query.data?.facets

	return (
		<div className="space-y-6">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
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
						<button type="button" className="link" onClick={() => showOnly('conflict:headcount')}>
							{summary.conflicts.headcount} headcount conflicts
						</button>{' '}
						·{' '}
						<button type="button" className="link" onClick={() => showOnly('conflict:address')}>
							{summary.conflicts.address ?? 0} address conflicts
						</button>{' '}
						·{' '}
						<button type="button" className="link" onClick={() => showOnly('stale')}>
							{summary.stale} with stale values
						</button>{' '}
						·{' '}
						<button type="button" className="link" onClick={() => showOnly('duplicates')}>
							{summary.possibleDuplicates} possible duplicates to check
						</button>
					</p>
				)}
			</QueryState>

			<FilterBar
				search={{
					label: 'Search companies',
					placeholder: 'Search name or domain',
					value: get('q'),
					onChange: (value) => update({ q: value }, { replace: true }),
				}}
				active={LIST_FILTERS.some((key) => params.has(key))}
				onClear={() => update(cleared)}
				count={query.data && `${formatInteger(query.data.total)} ${query.data.total === 1 ? 'company' : 'companies'}`}
			>
				<FilterSelect label="Show" all="All companies" value={filter} onChange={setFilter} options={FILTERS} />
				<FilterMultiSelect
					label="Country"
					all="All countries"
					value={many('country')}
					onChange={(value) => update({ country: value.join(',') })}
					options={(facets?.countries ?? []).map((code) => [code, `${countryName(code)} (${code})`])}
				/>
				<FilterMultiSelect
					label="Industry"
					all="All industries"
					value={many('industry')}
					onChange={(value) => update({ industry: value.join(',') })}
					options={(facets?.industries ?? []).map((industry) => [industry, industry])}
				/>
				<FilterMultiSelect
					label="Sources"
					all="All sources"
					value={many('source')}
					onChange={(value) => update({ source: value.join(',') })}
					options={PROVIDERS.map((provider) => [provider, PROVIDER_LABELS[provider]])}
				/>
				<FilterRange
					label="Headcount"
					stops={HEADCOUNT_STOPS}
					value={bounds('headcountMin', 'headcountMax')}
					onChange={setBounds('headcountMin', 'headcountMax')}
					format={formatInteger}
				/>
				<FilterRange
					label="Revenue"
					stops={REVENUE_STOPS}
					value={bounds('revenueMin', 'revenueMax')}
					onChange={setBounds('revenueMin', 'revenueMax')}
					format={formatGbpShort}
				/>
			</FilterBar>

			<QueryState query={query} empty="No companies match these filters." isEmpty={(data) => data.total === 0}>
				{(data) => (
					<div
						aria-busy={query.isPlaceholderData}
						className={cn('space-y-3 transition-opacity', query.isPlaceholderData && 'opacity-60')}
					>
						<Table className="[&>table]:min-w-[75rem] [&>table]:table-fixed">
							<TableHeader>
								<TableRow>
									{COLUMNS.map(([column, label, first, width], index) => (
										<TableSortHead
											key={column}
											label={label}
											className={cn(width, index > 0 && 'text-center')}
											direction={sort === column ? (dir as 'asc' | 'desc') : null}
											onSort={() => update(nextSort(column, first, { sort, dir }))}
										/>
									))}
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.companies.map((company) => (
									<TableRow key={company.id}>
										<TableCell>
											<Link
												to={`/companies/${company.id}`}
												title={company.name ?? undefined}
												className="link block w-fit max-w-full truncate font-medium"
											>
												{company.name ?? 'Unnamed'}
											</Link>
											<div title={company.domain ?? undefined} className="truncate text-xs text-muted-foreground">
												{company.domain ? <DomainLink domain={company.domain} quiet /> : 'no domain'}
											</div>
										</TableCell>
										<TableCell
											title={company.country ? countryName(company.country) : undefined}
											className="truncate text-center"
										>
											{company.country ? (
												<ValueLink companyId={company.id} field="country">
													{countryName(company.country)}
												</ValueLink>
											) : (
												<span className="text-muted-foreground">unknown</span>
											)}
										</TableCell>
										<TableCell title={company.industry ?? undefined} className="truncate text-center">
											{company.industry ? (
												<ValueLink companyId={company.id} field="industry">
													{company.industry}
												</ValueLink>
											) : (
												<span className="text-muted-foreground">unknown</span>
											)}
										</TableCell>
										<TableCell className="text-center tabular-nums">
											{company.headcount === null ? (
												'—'
											) : (
												<ValueLink companyId={company.id} field="headcount">
													{formatInteger(company.headcount)}
												</ValueLink>
											)}
										</TableCell>
										<TableCell className="truncate text-center tabular-nums">
											{company.revenueGbp === null ? (
												'—'
											) : (
												<ValueLink companyId={company.id} field="revenue">
													{formatGbp(company.revenueGbp)}
												</ValueLink>
											)}
										</TableCell>
										<TableCell className="whitespace-normal">
											<div className="flex flex-wrap justify-center gap-1">
												{company.providers.map((provider) => (
													<Badge key={provider} variant="outline">
														{PROVIDER_LABELS[provider]}
													</Badge>
												))}
											</div>
										</TableCell>
										<TableCell className="whitespace-normal">
											<div className="flex flex-wrap justify-center gap-1">
												{company.conflicts.map((field) =>
													company.overridden.includes(field) ? (
														<FlagLink key={`c-${field}`} companyId={company.id} field={field} variant="outline">
															<s className="text-muted-foreground">{FIELD_LABELS[field]} conflict</s> overridden
														</FlagLink>
													) : (
														<FlagLink key={`c-${field}`} companyId={company.id} field={field} variant="destructive">
															{FIELD_LABELS[field]} conflict
														</FlagLink>
													),
												)}
												{company.stale.map((field) => (
													<FlagLink key={`s-${field}`} companyId={company.id} field={field} variant="secondary">
														{FIELD_LABELS[field]} stale
													</FlagLink>
												))}
												{company.overridden
													.filter((field) => !company.conflicts.includes(field))
													.map((field) => (
														<FlagLink key={`o-${field}`} companyId={company.id} field={field} variant="outline">
															{FIELD_LABELS[field]} set by a person
														</FlagLink>
													))}
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
						<Pager
							page={pages.page}
							pageSize={data.pageSize}
							shown={data.companies.length}
							total={data.total}
							onFirst={pages.page > 0 ? pages.first : null}
							onPrevious={pages.page > 0 ? pages.previous : null}
							onNext={data.nextCursor ? () => pages.next(data.nextCursor!) : null}
						/>
					</div>
				)}
			</QueryState>
		</div>
	)
}
