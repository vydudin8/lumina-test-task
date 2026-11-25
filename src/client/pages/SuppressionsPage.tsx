import { JsonView } from '#client/components/JsonView.tsx'
import { Pager } from '#client/components/Pager.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { SearchInput } from '#client/components/SearchInput.tsx'
import { SuggestInput } from '#client/components/SuggestInput.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '#client/components/ui/card.tsx'
import { Label } from '#client/components/ui/label.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#client/components/ui/sheet.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { toast } from '#client/components/ui/toast.tsx'
import { useUserName } from '#client/domain/session.ts'
import { api } from '#client/lib/api.ts'
import { useDebounced } from '#client/lib/debounce.ts'
import { formatDate, formatDateTime, formatInteger } from '#client/lib/format.ts'
import { useCursorPages, useFilterParams } from '#client/lib/lists.ts'
import { CARD_STATUS_LABELS, PROVIDER_LABELS, type ProviderName } from '#common/settings.ts'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'

// Both lists are paged and searched on the server; `all` is the size of the list without a search.
interface Listed {
	total: number
	all: number
	pageSize: number
	nextCursor: string | null
}

interface OptOut {
	id: number
	reason: string
	source: string | null
	createdBy: string
	at: string
	personKeyHash: string
	email: string | null
	person: { fullName: string | null; title: string | null } | null
}

interface MailedRow {
	cardId: number
	personKeyHash: string
	email: string
	fullName: string | null
	submittedAt: string
	until: string
	status: string
	campaignId: number
	campaignName: string
}

interface OptOutsResponse extends Listed {
	optOuts: OptOut[]
	methods: string[]
}

interface MailedResponse extends Listed {
	recentlyMailed: MailedRow[]
	windowDays: number
}

interface Person {
	records: {
		id: number
		provider: ProviderName
		externalId: string
		email: string
		fullName: string | null
		title: string | null
		seniority: string
		functions: string[]
		emailStatus: string | null
		fetchedAt: string
		companyId: number | null
		companyName: string | null
		payload: unknown
	}[]
	optOut: { source: string | null; createdBy: string; at: string } | null
	cards: {
		id: number
		status: string
		submittedAt: string | null
		email: string | null
		fullName: string | null
		title: string | null
		campaignId: number
		campaignName: string
	}[]
}

// One list's search (in the URL) and page cursors, and the page the server sends for them.
function useServerList<T extends Listed>(list: 'opt-outs' | 'mailed', param: string) {
	const [params, update] = useFilterParams()
	const search = params.get(param) ?? ''
	const pages = useCursorPages(list, search.trim())
	const filters = new URLSearchParams()
	if (search.trim()) filters.set('q', search.trim())
	if (pages.cursor) filters.set('cursor', pages.cursor)
	const query = useQuery({
		queryKey: ['suppressions', list, filters.toString()],
		queryFn: () => api<T>(`/api/suppressions/${list}?${filters.toString()}`),
		placeholderData: keepPreviousData,
	})
	return {
		query,
		pages,
		search,
		setSearch: (value: string) => update({ [param]: value }, { replace: true }),
		openPerson: (hash: string) => update({ person: hash }),
	}
}

type ServerList<T extends Listed> = ReturnType<typeof useServerList<T>>

export function SuppressionsPage() {
	const queryClient = useQueryClient()
	const [params, update] = useFilterParams()
	const optOuts = useServerList<OptOutsResponse>('opt-outs', 'optOutsQ')
	const mailed = useServerList<MailedResponse>('mailed', 'mailedQ')
	const [email, setEmail] = useState('')
	const [source, setSource] = useState('')
	// Contact emails that start with what is typed, asked for once typing pauses (the same 300 ms as search boxes).
	const term = useDebounced(email.trim(), 300)
	const suggestions = useQuery({
		queryKey: ['contact-emails', term],
		queryFn: () => api<{ emails: string[] }>(`/api/contacts/emails?q=${encodeURIComponent(term)}`),
		enabled: term !== '',
		placeholderData: keepPreviousData,
	})
	// Opt-outs are taken only for an email a contact already has; the server checks it again.
	const known = suggestions.data?.emails.includes(email.trim().toLowerCase()) ?? false
	const unknown = term !== '' && !suggestions.isPlaceholderData && suggestions.data?.emails.length === 0
	const methods = optOuts.query.data?.methods ?? []
	const add = useMutation({
		mutationFn: () =>
			api<{ added: boolean }>('/api/suppressions', { method: 'POST', json: { email, source: source.trim() } }),
		onSuccess: async ({ added }) => {
			toast(
				added ? { title: 'Opt-out added', description: email } : { title: 'Already on the list', description: email },
			)
			setEmail('')
			setSource('')
			await queryClient.invalidateQueries()
		},
		onError: (error) => toast({ tone: 'error', title: 'Could not add the opt-out', description: error.message }),
	})

	return (
		<div className="space-y-8">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Suppression list</h1>
				<p className="max-w-3xl text-muted-foreground">
					Nobody here gets a postcard. Opt-outs are permanent and are stored as a hash of the email address only, so
					they still apply if the person's record is deleted. Anyone sent a card in the last{' '}
					{mailed.query.data?.windowDays ?? 90} days is also held back; that hold ends by itself.
				</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Add an opt-out</CardTitle>
				</CardHeader>
				<CardContent>
					<form
						className="grid gap-4 md:grid-cols-[2fr_1fr_auto] md:items-end"
						onSubmit={(event) => {
							event.preventDefault()
							add.mutate()
						}}
					>
						<div className="space-y-1">
							<Label htmlFor="optout-email">Email address</Label>
							<SuggestInput
								id="optout-email"
								type="email"
								placeholder="Start typing a contact's email"
								value={email}
								onChange={setEmail}
								options={email.trim() ? (suggestions.data?.emails ?? []) : []}
								allowNew={false}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="optout-source">Opt-out method</Label>
							<SuggestInput
								id="optout-source"
								placeholder="e.g. phone call"
								value={source}
								onChange={setSource}
								options={methods}
							/>
						</div>
						<Button type="submit" disabled={!known || add.isPending}>
							Add opt-out
						</Button>
					</form>
					{unknown && (
						<p className="mt-2 text-sm text-muted-foreground">No contact has an email that starts like this.</p>
					)}
				</CardContent>
			</Card>

			<OptOuts list={optOuts} />
			<Mailed list={mailed} />

			<PersonSheet hash={params.get('person')} onClose={() => update({ person: '' })} />
		</div>
	)
}

const heading = (title: string, data: Listed, filtered: boolean) =>
	`${title} (${filtered ? `${formatInteger(data.total)} of ${formatInteger(data.all)}` : formatInteger(data.total)})`

// Search appears only once a list outgrows one page (or while a search from the URL is still applied); a short list is
// just a table.
const isSearchable = (data: Listed, search: string) => data.all > data.pageSize || search.trim() !== ''

const pagerOf = <T extends Listed>({ pages }: ServerList<T>, data: Listed, shown: number) => ({
	page: pages.page,
	pageSize: data.pageSize,
	shown,
	total: data.total,
	onFirst: pages.page > 0 ? pages.first : null,
	onPrevious: pages.page > 0 ? pages.previous : null,
	onNext: data.nextCursor ? () => pages.next(data.nextCursor!) : null,
})

function OptOuts({ list }: { list: ServerList<OptOutsResponse> }) {
	const userName = useUserName()
	const filtered = list.search.trim() !== ''

	return (
		<QueryState query={list.query}>
			{(data) => (
				<section className="space-y-3">
					<h2 className="text-lg font-semibold">{heading('Opt-outs', data, filtered)}</h2>
					{isSearchable(data, list.search) && (
						<SearchInput
							aria-label="Search opt-outs"
							placeholder="Search name, email or method"
							className="w-full sm:w-72"
							value={list.search}
							onChange={list.setSearch}
						/>
					)}
					{data.optOuts.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							{filtered ? `Nobody here matches “${list.search}”.` : 'Nobody has opted out yet.'}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Person</TableHead>
									<TableHead>Email</TableHead>
									<TableHead>Opt-out method</TableHead>
									<TableHead>Added by</TableHead>
									<TableHead>Date</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.optOuts.map((row) => (
									<TableRow key={row.id}>
										<TableCell>
											<button
												type="button"
												className={
													row.person
														? 'link text-left'
														: 'text-left text-muted-foreground underline-offset-2 hover:underline'
												}
												onClick={() => list.openPerson(row.personKeyHash)}
											>
												{row.person
													? `${row.person.fullName}${row.person.title ? `, ${row.person.title}` : ''}`
													: 'Not in current provider data'}
											</button>
										</TableCell>
										<TableCell className="text-xs">
											{row.email ?? <span className="text-muted-foreground">only a hash is kept</span>}
										</TableCell>
										<TableCell>{row.source ?? '—'}</TableCell>
										<TableCell>{userName(row.createdBy)}</TableCell>
										<TableCell>{formatDateTime(row.at)}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
					<Pager {...pagerOf(list, data, data.optOuts.length)} />
				</section>
			)}
		</QueryState>
	)
}

function Mailed({ list }: { list: ServerList<MailedResponse> }) {
	const filtered = list.search.trim() !== ''

	return (
		<QueryState query={list.query}>
			{(data) => (
				<section className="space-y-3">
					<h2 className="text-lg font-semibold">
						{heading(`Mailed in the last ${data.windowDays} days`, data, filtered)}
					</h2>
					{isSearchable(data, list.search) && (
						<SearchInput
							aria-label="Search mailed people"
							placeholder="Search name, email or campaign"
							className="w-full sm:w-72"
							value={list.search}
							onChange={list.setSearch}
						/>
					)}
					{data.recentlyMailed.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							{filtered
								? `Nobody here matches “${list.search}”.`
								: `Nobody was mailed in the last ${data.windowDays} days.`}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Person</TableHead>
									<TableHead>Email</TableHead>
									<TableHead>Campaign</TableHead>
									<TableHead>Sent</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Held until</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.recentlyMailed.map((row) => (
									<TableRow key={row.cardId}>
										<TableCell>
											<button
												type="button"
												className="link text-left"
												onClick={() => list.openPerson(row.personKeyHash)}
											>
												{row.fullName}
											</button>
										</TableCell>
										<TableCell className="text-xs">{row.email}</TableCell>
										<TableCell>
											<Link to={`/campaigns/${row.campaignId}`} className="link">
												{row.campaignName}
											</Link>
										</TableCell>
										<TableCell>{formatDate(row.submittedAt)}</TableCell>
										<TableCell>{CARD_STATUS_LABELS[row.status] ?? row.status}</TableCell>
										<TableCell>{formatDate(row.until)}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
					<Pager {...pagerOf(list, data, data.recentlyMailed.length)} />
				</section>
			)}
		</QueryState>
	)
}

// One person beside the list (`?person=<hash of their email>`): what each provider sent, the opt-out and their cards.
function PersonSheet({ hash, onClose }: { hash: string | null; onClose: () => void }) {
	const userName = useUserName()
	const person = useQuery({
		queryKey: ['person', hash],
		queryFn: () => api<Person>(`/api/people/${hash}`),
		enabled: hash !== null,
	})
	const data = person.data
	const name =
		data?.records.find((record) => record.fullName)?.fullName ?? data?.cards.find((card) => card.fullName)?.fullName
	const email = data?.records[0]?.email ?? data?.cards.find((card) => card.email)?.email

	return (
		<Sheet open={hash !== null} onOpenChange={(open) => !open && onClose()}>
			<SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
				<SheetHeader>
					<SheetTitle>{name ?? (data ? 'Unknown person' : 'Person')}</SheetTitle>
					<SheetDescription>
						{email ?? (data ? 'Email address not stored: only a hash of it is kept.' : 'Loading…')}
					</SheetDescription>
				</SheetHeader>
				<div className="space-y-6 px-4 pb-4 text-sm">
					<QueryState query={person}>
						{(data) => (
							<>
								{data.records.length === 0 && (
									<p className="rounded-md border bg-muted p-3">
										{data.cards.length > 0
											? 'No provider lists this person any more. What is left is what their cards recorded when they were built.'
											: 'No provider lists this person any more, and the opt-out keeps only a hash of their email address, so their name and email cannot be shown. The opt-out still applies: if a provider lists them again, they get no postcard.'}
									</p>
								)}
								{data.optOut && (
									<section className="space-y-1">
										<h3 className="font-medium">Opted out</h3>
										<p>
											{data.optOut.source ?? 'No method recorded'} · added by {userName(data.optOut.createdBy)} on{' '}
											{formatDateTime(data.optOut.at)}
										</p>
									</section>
								)}
								{data.cards.length > 0 && (
									<section className="space-y-1">
										<h3 className="font-medium">Cards ({data.cards.length})</h3>
										<ul className="space-y-1">
											{data.cards.map((card) => (
												<li key={card.id}>
													<Link to={`/campaigns/${card.campaignId}`} className="link">
														{card.campaignName}
													</Link>{' '}
													· {CARD_STATUS_LABELS[card.status] ?? card.status}
													{card.submittedAt && ` · sent ${formatDate(card.submittedAt)}`}
												</li>
											))}
										</ul>
									</section>
								)}
								{data.records.map((record) => (
									<section key={record.id} className="space-y-2">
										<h3 className="font-medium">
											{PROVIDER_LABELS[record.provider]} record{' '}
											<span className="font-mono text-xs font-normal text-muted-foreground">{record.externalId}</span>
										</h3>
										<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
											<dt className="text-muted-foreground">Title</dt>
											<dd>
												{record.title ?? '—'} ({record.seniority.replace('_', ' ')})
											</dd>
											<dt className="text-muted-foreground">Company</dt>
											<dd>
												{record.companyId ? (
													<Link to={`/companies/${record.companyId}`} className="link">
														{record.companyName ?? `Company #${record.companyId}`}
													</Link>
												) : (
													'Not matched to a company'
												)}
											</dd>
											<dt className="text-muted-foreground">Fetched</dt>
											<dd>{formatDateTime(record.fetchedAt)}</dd>
										</dl>
										<JsonView value={record.payload} />
									</section>
								))}
							</>
						)}
					</QueryState>
				</div>
			</SheetContent>
		</Sheet>
	)
}
