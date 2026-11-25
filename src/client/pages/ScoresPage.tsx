import { FilterBar } from '#client/components/Filters.tsx'
import { Pager } from '#client/components/Pager.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { ScoreBreakdown } from '#client/components/ScoreBreakdown.tsx'
import { Badge } from '#client/components/ui/badge.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#client/components/ui/select.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#client/components/ui/sheet.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import {
	draftText,
	madeUpNumbers,
	markNumbers,
	placeCitations,
	rejectionSummary,
	type Rejection,
} from '#client/domain/llm.ts'
import type { Contribution } from '#client/domain/scores.ts'
import { api } from '#client/lib/api.ts'
import { formatDecimal, formatInteger } from '#client/lib/format.ts'
import { useCursorPages, useFilterParams } from '#client/lib/lists.ts'
import { cn } from '#client/lib/utils.ts'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, LoaderCircle } from 'lucide-react'
import { Tabs } from 'radix-ui'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'

interface Evidence {
	id: string
	label: string
	value: string
	source: string
	date: string | null
}

export interface Rationale {
	status: 'accepted' | 'rejected'
	text: string
	cites: string[]
	evidence: Evidence[]
	rejections: Rejection[]
	raw: string | null
	model: string
	promptVersion: string
}

const evidenceLine = (item: Evidence) =>
	`${item.id}: ${item.label} = ${item.value} (${item.source}${item.date ? `, ${item.date}` : ''})`

interface ScoresResponse {
	icp: { id: number }
	counts: { inProfile: number; outOfProfile: number }
	total: number
	pageSize: number
	nextCursor: string | null
	// One page of the tab asked for; the other tab's list is empty.
	ranked: {
		rank: number
		companyId: number
		name: string | null
		score: string
		display: number
		missed: { ruleId: string; outcome: string }[]
	}[]
	outOfProfile: { companyId: number; name: string | null; reasons: string[] }[]
}

interface ScoreDetail {
	icp: { id: number }
	company: { id: number; name: string | null }
	rank: number | null
	score: { inProfile: boolean; outReasons: string[]; score: string; display: number; contributions: Contribution[] }
	evidence: Evidence[]
	rationale: Rationale | null
}

// The explanation with its evidence marked where the text quotes it; each mark opens that item in the list below.
function CitedText({ rationale, onCite }: { rationale: Rationale; onCite: (id: string) => void }) {
	const cited = rationale.evidence.filter((item) => rationale.cites.includes(item.id))
	return (
		<p>
			{placeCitations(rationale.text, cited).map((part, index) => (
				<Fragment key={index}>
					{part.text}
					{part.cites.length > 0 && (
						<sup className="ml-0.5 text-[0.7em]">
							{part.cites.map((id, n) => (
								<Fragment key={id}>
									{n > 0 && ','}
									<button
										type="button"
										className="link leading-none font-medium"
										aria-label={`Evidence ${id}`}
										onClick={() => onCite(id)}
									>
										{id}
									</button>
								</Fragment>
							))}
						</sup>
					)}
				</Fragment>
			))}
		</p>
	)
}

// A rejected answer is kept for review above the template text that replaced it, with the made-up numbers marked.
export function RationaleView({ rationale, onCite }: { rationale: Rationale; onCite: (id: string) => void }) {
	const explanation = <CitedText rationale={rationale} onCite={onCite} />
	if (rationale.status === 'accepted') return <div className="text-sm">{explanation}</div>

	const draft = draftText(rationale.raw)
	const madeUp = rationale.rejections.flatMap(madeUpNumbers)
	// The text in use comes first; the draft the guard threw out stays one click away, for whoever wants to see why.
	return (
		<div className="space-y-2 text-sm">
			{explanation}
			<details className="text-xs text-muted-foreground">
				<summary className="cursor-pointer">
					<CircleAlert className="mr-1 inline size-3.5 align-[-0.15em] text-destructive" aria-hidden />
					Rejected AI draft · {rejectionSummary(rationale.rejections)}
				</summary>
				<div className="mt-2 space-y-1.5 border-l-2 border-destructive/40 pl-3">
					{draft && (
						<blockquote className="text-sm">
							“
							{markNumbers(draft, madeUp).map((part, index) =>
								part.marked ? (
									<mark key={index} className="rounded-sm bg-destructive-soft px-0.5 font-medium text-destructive">
										{part.text}
										<span className="sr-only"> (not in the evidence)</span>
									</mark>
								) : (
									part.text
								),
							)}
							”
						</blockquote>
					)}
					<ul className="space-y-0.5 text-destructive">
						{rationale.rejections.map((rejection) => (
							<li key={rejection.detail}>{rejection.detail.charAt(0).toUpperCase() + rejection.detail.slice(1)}.</li>
						))}
					</ul>
				</div>
			</details>
		</div>
	)
}

// Written as soon as the panel opens, unless one is already stored for exactly these facts; nobody has to ask.
function Explanation({
	companyId,
	version,
	stored,
	evidence,
}: {
	companyId: number
	version: string | null
	stored: Rationale | null
	evidence: Evidence[]
}) {
	const queryClient = useQueryClient()
	const { mutate, isError, error } = useMutation({
		mutationFn: () =>
			api<{ rationale: Rationale }>(`/api/scores/${companyId}/rationale${version ? `?version=${version}` : ''}`, {
				method: 'POST',
			}),
		onSuccess: ({ rationale }) =>
			queryClient.setQueryData<ScoreDetail>(['score', companyId, version], (old) => old && { ...old, rationale }),
	})
	// A ref, not the mutation's state: StrictMode runs the effect twice before that state changes.
	const started = useRef(false)
	useEffect(() => {
		if (stored || started.current) return
		started.current = true
		mutate()
	}, [stored, mutate])

	const [evidenceOpen, setEvidenceOpen] = useState(false)
	// The count restarts the flash when the same mark is clicked again.
	const [flash, setFlash] = useState<{ id: string; n: number } | null>(null)
	const cite = (id: string) => {
		setEvidenceOpen(true)
		setFlash((last) => ({ id, n: (last?.n ?? 0) + 1 }))
	}
	useEffect(() => {
		if (flash) document.getElementById(`evidence-${flash.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
	}, [flash])

	return (
		<div className="space-y-2 rounded-md border p-3">
			<div className="flex flex-wrap items-center gap-2">
				<h3 className="font-medium">Explanation</h3>
				{stored?.status === 'accepted' && (
					<Badge variant="secondary" title="Written by AI; every fact in it was checked against the evidence below">
						AI · fact-checked
					</Badge>
				)}
				{stored?.status === 'rejected' && (
					<Badge variant="outline" title="The AI text failed the checks, so a template built from the score is shown">
						Template
					</Badge>
				)}
				{stored && (
					<span className="ml-auto text-xs text-muted-foreground" title={`Prompt ${stored.promptVersion}`}>
						{stored.model}
					</span>
				)}
			</div>
			{stored ? (
				<RationaleView rationale={stored} onCite={cite} />
			) : isError ? (
				<div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
					<CircleAlert className="size-4 shrink-0" aria-hidden />
					Could not write the explanation: {error.message}
					<Button size="sm" variant="outline" onClick={() => mutate()}>
						Try again
					</Button>
				</div>
			) : (
				<p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
					<LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
					Writing the explanation, then checking every fact in it against the evidence…
				</p>
			)}
			<details
				open={evidenceOpen}
				onToggle={(event) => setEvidenceOpen(event.currentTarget.open)}
				className="text-xs text-muted-foreground"
			>
				<summary className="cursor-pointer">Evidence the AI may use</summary>
				<ul className="mt-1 space-y-0.5">
					{evidence.map((item) => (
						<li
							key={flash?.id === item.id ? `${item.id}-${flash.n}` : item.id}
							id={`evidence-${item.id}`}
							className={cn('rounded-sm px-1', flash?.id === item.id && 'animate-[row-flash_1.4s_ease-out]')}
						>
							{evidenceLine(item)}
						</li>
					))}
				</ul>
			</details>
		</div>
	)
}

const tabClass =
	'-mb-px flex items-center gap-2 border-b-2 border-transparent px-1 pb-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=active]:border-foreground data-[state=active]:font-medium data-[state=active]:text-foreground'

function TabTrigger({ value, count, children }: { value: string; count: number; children: ReactNode }) {
	return (
		<Tabs.Trigger value={value} className={tabClass}>
			{children}
			<span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
				{formatInteger(count)}
			</span>
		</Tabs.Trigger>
	)
}

export function ScoresPage() {
	const [params, update] = useFilterParams()
	const version = params.get('version')
	const selected = params.get('company')
	const tab = params.get('tab') === 'out' ? 'out' : 'in'
	const search = params.get('q') ?? ''
	const filters = new URLSearchParams()
	if (version) filters.set('version', version)
	if (tab === 'out') filters.set('tab', 'out')
	if (search.trim()) filters.set('q', search.trim())
	// Any change to the version, the tab or the search starts again from page one.
	const pages = useCursorPages('scores', filters.toString())
	const request = new URLSearchParams(filters)
	if (pages.cursor) request.set('cursor', pages.cursor)
	const scores = useQuery({
		queryKey: ['scores', request.toString()],
		queryFn: () => api<ScoresResponse>(`/api/scores?${request.toString()}`),
		placeholderData: keepPreviousData,
	})
	const versions = useQuery({ queryKey: ['icp'], queryFn: () => api<{ versions: { id: number }[] }>('/api/icp') })
	const select = (companyId: number) => update({ company: String(companyId) })

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">Scores</h1>
					<p className="max-w-2xl text-muted-foreground">
						Companies in the profile, best fit first. Equal scores are ordered by company number, so the list is stable.
						The AI explanation describes the score; it never changes it.
					</p>
				</div>
				<Select
					value={version ?? String(scores.data?.icp.id ?? '')}
					onValueChange={(value) => update({ version: value })}
				>
					<SelectTrigger aria-label="ICP version" className="w-44">
						<SelectValue placeholder="ICP version" />
					</SelectTrigger>
					<SelectContent>
						{versions.data?.versions.map((option) => (
							<SelectItem key={option.id} value={String(option.id)}>
								ICP version {option.id}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<QueryState query={scores}>
				{(data) => {
					const { ranked, outOfProfile: out, total } = data
					const empty = search ? `No company matches “${search}”.` : 'No companies here.'
					return (
						<Tabs.Root
							value={tab}
							onValueChange={(value) => update({ tab: value === 'out' ? 'out' : '' })}
							className="space-y-4"
						>
							<Tabs.List aria-label={`ICP version ${data.icp.id}`} className="flex gap-6 border-b">
								<TabTrigger value="in" count={data.counts.inProfile}>
									In the profile
								</TabTrigger>
								<TabTrigger value="out" count={data.counts.outOfProfile}>
									Out of the profile
								</TabTrigger>
							</Tabs.List>
							<FilterBar
								search={{
									label: 'Search companies',
									placeholder: 'Search company name',
									value: search,
									onChange: (value) => update({ q: value }, { replace: true }),
								}}
								active={search !== ''}
								onClear={() => update({ q: '' })}
								count={`${formatInteger(total)} ${total === 1 ? 'company' : 'companies'}`}
							/>
							<Tabs.Content value="in">
								{ranked.length === 0 ? (
									<p className="text-sm text-muted-foreground">{empty}</p>
								) : (
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead className="w-12">#</TableHead>
												<TableHead>Company</TableHead>
												<TableHead className="w-20 text-right">Score</TableHead>
												<TableHead>Missed</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{ranked.map((row) => (
												<TableRow
													key={row.companyId}
													data-state={String(row.companyId) === selected ? 'selected' : undefined}
													onClick={() => select(row.companyId)}
												>
													<TableCell className="tabular-nums">{row.rank}</TableCell>
													<TableCell>
														<button type="button" className="text-left underline-offset-2 hover:underline">
															{row.name}
														</button>
													</TableCell>
													<TableCell className="text-right tabular-nums" title={`Exact: ${row.score}`}>
														{row.display}
													</TableCell>
													<TableCell className="whitespace-normal">
														<div className="flex flex-wrap gap-1">
															{row.missed.map((miss) => (
																<Badge key={miss.ruleId} variant={miss.outcome === 'unknown' ? 'outline' : 'secondary'}>
																	{miss.ruleId} {miss.outcome}
																</Badge>
															))}
														</div>
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								)}
							</Tabs.Content>
							<Tabs.Content value="out">
								{out.length === 0 ? (
									<p className="text-sm text-muted-foreground">{empty}</p>
								) : (
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Company</TableHead>
												<TableHead>Why it is out</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{out.map((row) => (
												<TableRow
													key={row.companyId}
													data-state={String(row.companyId) === selected ? 'selected' : undefined}
													onClick={() => select(row.companyId)}
												>
													<TableCell>
														<button type="button" className="text-left underline-offset-2 hover:underline">
															{row.name}
														</button>
													</TableCell>
													<TableCell className="whitespace-normal text-muted-foreground">
														{row.reasons.join('; ')}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								)}
							</Tabs.Content>
							<Pager
								page={pages.page}
								pageSize={data.pageSize}
								shown={tab === 'in' ? ranked.length : out.length}
								total={total}
								onFirst={pages.page > 0 ? pages.first : null}
								onPrevious={pages.page > 0 ? pages.previous : null}
								onNext={data.nextCursor ? () => pages.next(data.nextCursor!) : null}
							/>
						</Tabs.Root>
					)
				}}
			</QueryState>

			<ScoreSheet
				companyId={selected ? Number(selected) : null}
				version={version}
				onClose={() => update({ company: '' })}
			/>
		</div>
	)
}

// The breakdown slides in beside the list (`?company=<id>`), so Back closes it and the list keeps its place.
function ScoreSheet({
	companyId,
	version,
	onClose,
}: {
	companyId: number | null
	version: string | null
	onClose: () => void
}) {
	const suffix = version ? `?version=${version}` : ''
	const detail = useQuery({
		queryKey: ['score', companyId, version],
		queryFn: () => api<ScoreDetail>(`/api/scores/${companyId}${suffix}`),
		enabled: companyId !== null,
	})
	const data = detail.data
	const available = data?.score.contributions.reduce((sum, c) => sum + c.points, 0)
	const earned = data?.score.contributions.reduce((sum, c) => sum + c.earned, 0)

	return (
		<Sheet open={companyId !== null} onOpenChange={(open) => !open && onClose()}>
			<SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
				<SheetHeader>
					<SheetTitle>
						{data ? (
							<Link to={`/companies/${data.company.id}`} className="link">
								{data.company.name}
							</Link>
						) : (
							'Score explanation'
						)}
					</SheetTitle>
					<SheetDescription>
						{data ? (
							<>
								{data.score.inProfile
									? `Rank ${data.rank}, score ${data.score.display}`
									: `Out of the profile: ${data.score.outReasons.join('; ')}`}{' '}
								· {earned} of {available} points ={' '}
								<span title={formatDecimal(data.score.score) === data.score.score ? undefined : data.score.score}>
									{formatDecimal(data.score.score)}
								</span>
							</>
						) : (
							'How the score adds up, rule by rule.'
						)}
					</SheetDescription>
				</SheetHeader>
				<div className="space-y-4 px-4 pb-4">
					<QueryState query={detail}>
						{(data) => (
							<>
								<ScoreBreakdown companyId={data.company.id} contributions={data.score.contributions} />

								<Explanation
									key={`${data.company.id}:${version}`}
									companyId={data.company.id}
									version={version}
									stored={data.rationale}
									evidence={data.evidence}
								/>
							</>
						)}
					</QueryState>
				</div>
			</SheetContent>
		</Sheet>
	)
}
