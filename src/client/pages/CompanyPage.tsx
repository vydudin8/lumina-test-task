import { api } from '#client/api.ts'
import { ActivityTimeline, type AuditEvent } from '#client/components/ActivityTimeline.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { ReasonDialog } from '#client/components/ReasonDialog.tsx'
import { Badge } from '#client/components/ui/badge.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import {
	formatAddress,
	formatDate,
	formatDateTime,
	formatGbp,
	formatInteger,
	formatMoney,
	type AddressValue,
} from '#client/format.ts'
import {
	CONFLICT_RELATIVE_DIFFERENCE,
	FIELD_LABELS,
	FIELD_PRECEDENCE,
	FIELDS,
	PROVIDER_LABELS,
	SIGNAL_LABELS,
	STALE_AFTER_MONTHS,
	type FieldName,
	type ProviderName,
} from '#common/settings.ts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

interface Revenue {
	amount: string
	currency: string
	gbp: string
	rate: string
	rateAsOf: string
}

interface Candidate {
	sourceId: number
	provider: ProviderName
	rawRecordId: number
	value: unknown
	asOf: string | null
}

interface Field {
	value: unknown
	sourceId: number | null
	provider: ProviderName | null
	rawRecordId: number | null
	fetchedAt: string | null
	asOf: string | null
	stale: boolean
	conflict: boolean
	candidates: Candidate[]
	override: { createdBy: string; reason: string; at: string } | null
}

interface Source {
	id: number
	provider: ProviderName
	externalId: string
	rawRecordId: number
	fetchedAt: string
	name: string | null
	domain: string | null
	country: string | null
	industryLabel: string | null
}

interface Contact {
	id: number
	fullName: string | null
	title: string | null
	seniority: string
	functions: string[]
	personKey: string
	provider: ProviderName
	rawRecordId: number
}

interface Detail {
	company: { id: number; sources: Source[]; fields: Record<FieldName, Field> }
	contacts: Contact[]
	possibleDuplicates: { companyId: number; name: string | null; reason: string }[]
	activity: AuditEvent[]
}

function renderValue(field: FieldName, value: unknown) {
	if (value === null || value === undefined) return <span className="text-muted-foreground">unknown</span>
	if (field === 'headcount') return formatInteger(value as number)
	if (field === 'address') return formatAddress(value as AddressValue)
	if (field === 'signals') return (value as string[]).map((signal) => SIGNAL_LABELS[signal] ?? signal).join(', ')
	if (field === 'revenue') {
		const revenue = value as Revenue
		return (
			<>
				{formatGbp(revenue.gbp)}
				{revenue.currency !== 'GBP' && (
					<span className="block text-xs text-muted-foreground">
						from {formatMoney(revenue.amount, revenue.currency)} at {revenue.rate} GBP per {revenue.currency}, rate of{' '}
						{formatDate(revenue.rateAsOf)}
					</span>
				)}
			</>
		)
	}
	return typeof value === 'string' ? value : JSON.stringify(value)
}

function whyThisValue(field: FieldName, value: Field) {
	if (value.override)
		return `Chosen by ${value.override.createdBy} on ${formatDate(value.override.at)}: “${value.override.reason}”`
	if (field === 'signals')
		return value.candidates.length ? 'Every signal any provider reports counts.' : 'No provider reports a signal.'
	if (!value.provider) return 'No provider reports this.'
	if (value.candidates.length === 1) return `Only ${PROVIDER_LABELS[value.provider]} reports this.`
	const order = FIELD_PRECEDENCE[field].map((provider) => PROVIDER_LABELS[provider])
	return `${PROVIDER_LABELS[value.provider]} wins: for ${FIELD_LABELS[field].toLowerCase()} we trust ${order.join(', then ')}.`
}

const rawLink = (rawRecordId: number) => `/providers?record=${rawRecordId}`

export function CompanyPage() {
	const id = Number(useParams().id)
	const query = useQuery({ queryKey: ['company', id], queryFn: () => api<Detail>(`/api/companies/${id}`) })

	return <QueryState query={query}>{(detail) => <CompanyDetail detail={detail} />}</QueryState>
}

function CompanyDetail({ detail }: { detail: Detail }) {
	const { company } = detail
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	const [overriding, setOverriding] = useState<FieldName | null>(null)
	const [choice, setChoice] = useState<number | null>(null)
	const [splitting, setSplitting] = useState<Source | null>(null)
	const [merging, setMerging] = useState<{ companyId: number; name: string | null } | null>(null)
	const [notice, setNotice] = useState<{ text: string; companyId?: number } | null>(null)

	const refresh = () => queryClient.invalidateQueries()
	const name = (company.fields.name.value as string | null) ?? 'Unnamed company'

	return (
		<div className="space-y-8">
			<div className="space-y-1">
				<p className="text-sm">
					<Link to="/companies" className="text-muted-foreground underline-offset-2 hover:underline">
						Companies
					</Link>
				</p>
				<h1 className="text-2xl font-semibold">{name}</h1>
				<p className="text-muted-foreground">
					{(company.fields.domain.value as string | null) ?? 'no domain'} · company #{company.id} ·{' '}
					{company.sources.length} {company.sources.length === 1 ? 'source record' : 'source records'}
				</p>
				{notice && (
					<p className="text-sm">
						{notice.text}{' '}
						{notice.companyId && (
							<Link to={`/companies/${notice.companyId}`} className="underline underline-offset-2">
								Open company #{notice.companyId}
							</Link>
						)}
					</p>
				)}
			</div>

			<section className="space-y-2">
				<h2 className="text-lg font-semibold">Fields</h2>
				<p className="text-sm text-muted-foreground">
					Conflict: providers differ (headcount and revenue by more than {Number(CONFLICT_RELATIVE_DIFFERENCE) * 100}%).
					Stale: the provider's own date is more than {STALE_AFTER_MONTHS} months old.
				</p>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Field</TableHead>
							<TableHead>Value</TableHead>
							<TableHead>Source</TableHead>
							<TableHead>Dates</TableHead>
							<TableHead>Why this value</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{FIELDS.map((field) => {
							const value = company.fields[field]
							return (
								<TableRow key={field} className="align-top">
									<TableCell className="font-medium">
										{FIELD_LABELS[field]}
										<div className="mt-1 space-x-1">
											{value.conflict && <Badge variant="destructive">Conflict</Badge>}
											{value.stale && <Badge variant="secondary">Stale</Badge>}
											{value.override && <Badge variant="outline">Set by a person</Badge>}
										</div>
									</TableCell>
									<TableCell className="max-w-72 whitespace-normal">
										{renderValue(field, value.value)}
										{value.conflict && (
											<ul className="mt-1 text-xs text-muted-foreground">
												{value.candidates.map((candidate) => (
													<li key={candidate.sourceId}>
														{PROVIDER_LABELS[candidate.provider]}: {renderValue(field, candidate.value)}
													</li>
												))}
											</ul>
										)}
									</TableCell>
									<TableCell>
										{field === 'signals' ? (
											value.candidates.map((candidate) => (
												<Link
													key={candidate.sourceId}
													to={rawLink(candidate.rawRecordId)}
													className="mr-2 underline underline-offset-2"
												>
													{PROVIDER_LABELS[candidate.provider]}
												</Link>
											))
										) : value.provider && value.rawRecordId ? (
											<Link to={rawLink(value.rawRecordId)} className="underline underline-offset-2">
												{PROVIDER_LABELS[value.provider]} record
											</Link>
										) : (
											'—'
										)}
									</TableCell>
									<TableCell className="text-xs">
										{value.asOf && <div>Provider date: {formatDate(value.asOf)}</div>}
										{value.fetchedAt && (
											<div className="text-muted-foreground">Fetched: {formatDateTime(value.fetchedAt)}</div>
										)}
									</TableCell>
									<TableCell className="max-w-64 text-xs whitespace-normal">{whyThisValue(field, value)}</TableCell>
									<TableCell>
										{field !== 'signals' &&
											new Set(value.candidates.map((candidate) => JSON.stringify(candidate.value))).size > 1 && (
												<Button
													size="sm"
													variant="outline"
													onClick={() => {
														setChoice(value.sourceId)
														setOverriding(field)
													}}
												>
													Choose value
												</Button>
											)}
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			</section>

			<section className="space-y-2">
				<h2 className="text-lg font-semibold">Source records</h2>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Provider</TableHead>
							<TableHead>Provider id</TableHead>
							<TableHead>Name as sent</TableHead>
							<TableHead>Domain</TableHead>
							<TableHead>Fetched</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{company.sources.map((source) => (
							<TableRow key={source.id}>
								<TableCell>{PROVIDER_LABELS[source.provider]}</TableCell>
								<TableCell className="font-mono text-xs">{source.externalId}</TableCell>
								<TableCell>{source.name}</TableCell>
								<TableCell>{source.domain ?? '—'}</TableCell>
								<TableCell>{formatDateTime(source.fetchedAt)}</TableCell>
								<TableCell className="space-x-2 text-right">
									<Link to={rawLink(source.rawRecordId)} className="text-sm underline underline-offset-2">
										Raw JSON
									</Link>
									{company.sources.length > 1 && (
										<Button size="sm" variant="outline" onClick={() => setSplitting(source)}>
											Split off
										</Button>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</section>

			{detail.possibleDuplicates.length > 0 && (
				<section className="space-y-2">
					<h2 className="text-lg font-semibold">Possible duplicates</h2>
					<p className="text-sm text-muted-foreground">These were not merged automatically. A person decides.</p>
					<ul className="space-y-2">
						{detail.possibleDuplicates.map((duplicate) => (
							<li key={duplicate.companyId} className="flex items-center gap-3 text-sm">
								<Link to={`/companies/${duplicate.companyId}`} className="underline underline-offset-2">
									{duplicate.name ?? `Company #${duplicate.companyId}`}
								</Link>
								<span className="text-muted-foreground">{duplicate.reason}</span>
								<Button size="sm" variant="outline" onClick={() => setMerging(duplicate)}>
									Merge into this company
								</Button>
							</li>
						))}
					</ul>
				</section>
			)}

			<section className="space-y-2">
				<h2 className="text-lg font-semibold">Contacts ({detail.contacts.length})</h2>
				{detail.contacts.length === 0 ? (
					<p className="text-sm text-muted-foreground">No provider lists anyone at this company.</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead>Title</TableHead>
								<TableHead>Seniority</TableHead>
								<TableHead>Functions</TableHead>
								<TableHead>Email</TableHead>
								<TableHead>Source</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{detail.contacts.map((contact) => (
								<TableRow key={contact.id}>
									<TableCell>{contact.fullName}</TableCell>
									<TableCell>{contact.title}</TableCell>
									<TableCell>{contact.seniority.replace('_', ' ')}</TableCell>
									<TableCell className="text-xs">{contact.functions.join(', ') || '—'}</TableCell>
									<TableCell className="text-xs">{contact.personKey}</TableCell>
									<TableCell>
										<Link to={rawLink(contact.rawRecordId)} className="underline underline-offset-2">
											{PROVIDER_LABELS[contact.provider]}
										</Link>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</section>

			<section className="space-y-2">
				<h2 className="text-lg font-semibold">Activity</h2>
				<ActivityTimeline events={detail.activity} />
			</section>

			<ReasonDialog
				open={overriding !== null}
				onOpenChange={(open) => !open && setOverriding(null)}
				title={`Choose the ${overriding ? FIELD_LABELS[overriding].toLowerCase() : ''}`}
				description="Your choice replaces the automatic pick for this company and stays in place after future pulls."
				confirmLabel="Use this value"
				disabled={choice === null}
				onConfirm={async (reason) => {
					await api(`/api/companies/${company.id}/overrides`, {
						method: 'POST',
						json: { field: overriding, sourceId: choice, reason },
					})
					await refresh()
				}}
			>
				<fieldset className="space-y-2">
					<legend className="sr-only">Values</legend>
					{overriding &&
						company.fields[overriding].candidates.map((candidate) => (
							<label key={candidate.sourceId} className="flex items-start gap-2 text-sm">
								<input
									type="radio"
									name="candidate"
									checked={choice === candidate.sourceId}
									onChange={() => setChoice(candidate.sourceId)}
									className="mt-1"
								/>
								<span>
									{PROVIDER_LABELS[candidate.provider]}: {renderValue(overriding, candidate.value)}
								</span>
							</label>
						))}
				</fieldset>
			</ReasonDialog>

			<ReasonDialog
				open={splitting !== null}
				onOpenChange={(open) => !open && setSplitting(null)}
				title="Split off this record"
				description={`The ${splitting ? PROVIDER_LABELS[splitting.provider] : ''} record becomes a separate company, together with its contacts. It will not be merged back automatically.`}
				confirmLabel="Split off"
				onConfirm={async (reason) => {
					const result = await api<{ companyId: number }>(`/api/companies/${company.id}/unmerge`, {
						method: 'POST',
						json: { sourceId: splitting!.id, reason },
					})
					setNotice({
						text: 'Record split off.',
						companyId: result.companyId === company.id ? undefined : result.companyId,
					})
					await refresh()
				}}
			/>

			<ReasonDialog
				open={merging !== null}
				onOpenChange={(open) => !open && setMerging(null)}
				title="Merge companies"
				description={`${merging?.name ?? 'The other company'} and ${name} become one company. Fields are picked by the usual provider precedence.`}
				confirmLabel="Merge"
				onConfirm={async (reason) => {
					const result = await api<{ companyId: number }>(`/api/companies/${company.id}/merge`, {
						method: 'POST',
						json: { otherCompanyId: merging!.companyId, reason },
					})
					await refresh()
					if (result.companyId !== company.id) await navigate(`/companies/${result.companyId}`)
				}}
			/>
		</div>
	)
}
