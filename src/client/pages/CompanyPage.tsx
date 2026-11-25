import { ActivityTimeline } from '#client/components/ActivityTimeline.tsx'
import { DomainLink } from '#client/components/DomainLink.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { ReasonDialog } from '#client/components/ReasonDialog.tsx'
import { Badge } from '#client/components/ui/badge.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#client/components/ui/sheet.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { toast } from '#client/components/ui/toast.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '#client/components/ui/tooltip.tsx'
import type { AuditEvent } from '#client/domain/audit.ts'
import { useUserName } from '#client/domain/session.ts'
import { api } from '#client/lib/api.ts'
import { formatDate, formatDateTime, formatFieldValue, formatGbp, formatMoney } from '#client/lib/format.ts'
import { useFilterParams } from '#client/lib/lists.ts'
import { cn } from '#client/lib/utils.ts'
import {
	CONFLICT_RELATIVE_DIFFERENCE,
	FIELD_LABELS,
	FIELD_PRECEDENCE,
	FIELDS,
	PROVIDER_LABELS,
	STALE_AFTER_MONTHS,
	type FieldName,
	type ProviderName,
} from '#common/settings.ts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'

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
	// Merges in the activity whose two sides are both still here.
	undoableMerges: number[]
}

function renderValue(field: FieldName, value: unknown) {
	if (value === null || value === undefined) return <span className="text-muted-foreground">unknown</span>
	if (field === 'domain' && typeof value === 'string') return <DomainLink domain={value} />
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
	return formatFieldValue(field, value)
}

function whyThisValue(field: FieldName, value: Field, userName: (id: string) => string) {
	if (value.override)
		return `Chosen by ${userName(value.override.createdBy)} on ${formatDate(value.override.at)}: “${value.override.reason}”`
	if (field === 'signals')
		return value.candidates.length ? 'Every signal any provider reports counts.' : 'No provider reports a signal.'
	if (!value.provider) return 'No provider reports this.'
	if (value.candidates.length === 1) return `Only ${PROVIDER_LABELS[value.provider]} reports this.`
	const order = FIELD_PRECEDENCE[field].map((provider) => PROVIDER_LABELS[provider])
	return `${PROVIDER_LABELS[value.provider]} wins: for ${FIELD_LABELS[field].toLowerCase()} we trust ${order.join(', then ')}.`
}

// Opens the raw record in the side sheet over this page (see RawRecordSheet), not on Providers.
const rawLink = (rawRecordId: number) => `?record=${rawRecordId}`
const distinct = (values: (string | null)[]) => [...new Set(values.filter(Boolean))].join(' / ') || '—'

export function CompanyPage() {
	const id = Number(useParams().id)
	const query = useQuery({ queryKey: ['company', id], queryFn: () => api<Detail>(`/api/companies/${id}`) })

	return <QueryState query={query}>{(detail) => <CompanyDetail detail={detail} requestedId={id} />}</QueryState>
}

function CompanyDetail({ detail, requestedId }: { detail: Detail; requestedId: number }) {
	const userName = useUserName()
	const location = useLocation()
	const { hash } = location
	const mergedFrom = (location.state as { mergedFrom?: number } | null)?.mergedFrom
	// Arriving from a score or a list flag: bring the field into view; its row flashes once (row-flash in styles.css).
	useEffect(() => {
		if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'center' })
	}, [hash])
	const { company } = detail
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	const [overriding, setOverriding] = useState<FieldName | null>(null)
	const [choice, setChoice] = useState<number | null>(null)
	const [splitting, setSplitting] = useState<Source | null>(null)
	const [merging, setMerging] = useState<{ companyId: number; name: string | null } | null>(null)
	const [undoing, setUndoing] = useState<AuditEvent | null>(null)
	// The server answers a number merged away with the company it went into: put that company's own number in the URL.
	useEffect(() => {
		if (requestedId !== company.id)
			void navigate(`/companies/${company.id}${hash}`, { replace: true, state: { mergedFrom: requestedId } })
	}, [requestedId, company.id, hash, navigate])

	const refresh = () => queryClient.invalidateQueries()
	// Providers that list the same email are one person, as in recipient choice and suppression.
	const people = Object.values(Object.groupBy(detail.contacts, (contact) => contact.personKey)).filter(
		(records) => records !== undefined,
	)
	const name = (company.fields.name.value as string | null) ?? 'Unnamed company'
	const domain = company.fields.domain.value as string | null

	return (
		<div className="space-y-8">
			<div className="flex items-start justify-between gap-4">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
					<p className="text-muted-foreground">
						{domain ? <DomainLink domain={domain} /> : 'no domain'} · company #{company.id} · {company.sources.length}{' '}
						{company.sources.length === 1 ? 'source record' : 'source records'}
					</p>
					{mergedFrom && (
						<p className="text-sm text-muted-foreground">Company #{mergedFrom} was merged into this one.</p>
					)}
				</div>
				<CompanyHistory
					events={detail.activity}
					self={`company:${company.id}`}
					undoable={detail.undoableMerges}
					onUndo={setUndoing}
				/>
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
								<TableRow
									key={field}
									id={`field-${field}`}
									className={cn('align-top', hash === `#field-${field}` && 'animate-[row-flash_1.4s_ease-out]')}
								>
									<TableCell className="font-medium">
										{FIELD_LABELS[field]}
										<div className="mt-1 space-x-1">
											{value.conflict && value.override ? (
												<Badge variant="outline">
													<s className="text-muted-foreground">Conflict</s> overridden
												</Badge>
											) : (
												value.conflict && <Badge variant="destructive">Conflict</Badge>
											)}
											{value.stale && <Badge variant="secondary">Stale</Badge>}
											{value.override && !value.conflict && <Badge variant="outline">Set by a person</Badge>}
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
												<Link key={candidate.sourceId} to={rawLink(candidate.rawRecordId)} className="link mr-2">
													{PROVIDER_LABELS[candidate.provider]}
												</Link>
											))
										) : value.provider && value.rawRecordId ? (
											<Link to={rawLink(value.rawRecordId)} className="link">
												{PROVIDER_LABELS[value.provider]}
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
									<TableCell className="max-w-64 text-xs whitespace-normal">
										{whyThisValue(field, value, userName)}
									</TableCell>
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
				{company.sources.length > 1 && (
					<p className="max-w-3xl text-sm text-muted-foreground">
						These provider records were matched as one company. If one of them is a different company, split it off: it
						becomes a company of its own with its contacts, the reason goes to the audit log, and later pulls do not
						merge it back.
					</p>
				)}
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
								<TableCell>{source.domain ? <DomainLink domain={source.domain} /> : '—'}</TableCell>
								<TableCell>{formatDateTime(source.fetchedAt)}</TableCell>
								<TableCell className="space-x-2 text-right">
									<Link to={rawLink(source.rawRecordId)} className="link text-sm">
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
								<Link to={`/companies/${duplicate.companyId}`} className="link">
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
				<h2 className="text-lg font-semibold">Contacts ({people.length})</h2>
				{people.length < detail.contacts.length && (
					<p className="text-sm text-muted-foreground">
						{detail.contacts.length} provider records for {people.length} {people.length === 1 ? 'person' : 'people'}:
						records with the same email are one person.
					</p>
				)}
				{people.length === 0 ? (
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
								<TableHead>Sources</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{people.map((records) => (
								<TableRow key={records[0]!.personKey}>
									<TableCell>{distinct(records.map((record) => record.fullName))}</TableCell>
									<TableCell>{distinct(records.map((record) => record.title))}</TableCell>
									<TableCell>{distinct(records.map((record) => record.seniority.replace('_', ' ')))}</TableCell>
									<TableCell className="text-xs">
										{[...new Set(records.flatMap((record) => record.functions))].join(', ') || '—'}
									</TableCell>
									<TableCell className="text-xs">{records[0]!.personKey}</TableCell>
									<TableCell className="space-x-2">
										{records.map((record) => (
											<Link key={record.id} to={rawLink(record.rawRecordId)} className="link">
												{PROVIDER_LABELS[record.provider]}
											</Link>
										))}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
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
					toast({ title: `${FIELD_LABELS[overriding!]} chosen`, description: name })
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
					toast({
						title: 'Record split off',
						description: `The ${PROVIDER_LABELS[splitting!.provider]} record is now its own company.`,
						action:
							result.companyId === company.id
								? undefined
								: { label: `Open company #${result.companyId}`, to: `/companies/${result.companyId}` },
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
					toast({ title: 'Companies merged', description: `${merging!.name} and ${name} are now one company.` })
					await refresh()
					if (result.companyId !== company.id) await navigate(`/companies/${result.companyId}`)
				}}
			/>

			<ReasonDialog
				open={undoing !== null}
				onOpenChange={(open) => !open && setUndoing(null)}
				title="Undo this merge"
				description="The provider records that came from each company go back to it, under its old number, with their contacts and chosen values. They will not be merged back automatically."
				confirmLabel="Undo merge"
				onConfirm={async (reason) => {
					const result = await api<{ companyIds: number[] }>(`/api/companies/${company.id}/undo-merge`, {
						method: 'POST',
						json: { mergeEventId: undoing!.id, reason },
					})
					const other = result.companyIds.find((id) => id !== company.id)
					toast({
						title: 'Merge undone',
						description: `The records are back in companies ${result.companyIds.map((id) => `#${id}`).join(' and ')}.`,
						action: other ? { label: `Open company #${other}`, to: `/companies/${other}` } : undefined,
					})
					await refresh()
					if (!result.companyIds.includes(company.id)) await navigate(`/companies/${result.companyIds[0]}`)
				}}
			/>
		</div>
	)
}

// In the URL (`history`), like the campaign history: Back closes it and a reload keeps it open.
function CompanyHistory({
	events,
	self,
	undoable,
	onUndo,
}: {
	events: AuditEvent[]
	self: string
	undoable: number[]
	onUndo: (event: AuditEvent) => void
}) {
	const [params, update] = useFilterParams()
	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button variant="outline" size="icon" aria-label="History" onClick={() => update({ history: '1' })}>
						<History />
					</Button>
				</TooltipTrigger>
				<TooltipContent>History</TooltipContent>
			</Tooltip>
			<Sheet open={params.get('history') === '1'} onOpenChange={(open) => !open && update({ history: '', event: '' })}>
				<SheetContent className="w-full overflow-y-auto sm:max-w-xl">
					<SheetHeader>
						<SheetTitle>History</SheetTitle>
						<SheetDescription>What happened to this company, newest first.</SheetDescription>
					</SheetHeader>
					<div className="px-4 pb-4">
						<ActivityTimeline
							events={events}
							self={self}
							action={(event) =>
								undoable.includes(event.id) && (
									<Button variant="outline" size="sm" onClick={() => onUndo(event)}>
										Undo merge
									</Button>
								)
							}
						/>
					</div>
				</SheetContent>
			</Sheet>
		</>
	)
}
