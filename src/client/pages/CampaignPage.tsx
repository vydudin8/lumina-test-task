import { api } from '#client/api.ts'
import { ActivityTimeline, type AuditEvent } from '#client/components/ActivityTimeline.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { ReasonDialog } from '#client/components/ReasonDialog.tsx'
import { Badge } from '#client/components/ui/badge.tsx'
import { Button } from '#client/components/ui/button.tsx'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '#client/components/ui/dialog.tsx'
import { Label } from '#client/components/ui/label.tsx'
import { Textarea } from '#client/components/ui/textarea.tsx'
import { formatAddress, formatDateTime, type AddressValue } from '#client/format.ts'
import { useSession, useUserName } from '#client/session.ts'
import { BLOCK_REASON_LABELS, CARD_STATUS_LABELS, PROVIDER_LABELS, type ProviderName } from '#common/settings.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import type { CampaignSummary } from './CampaignsPage.tsx'

interface Candidate {
	personKey: string
	fullName: string | null
	title: string | null
	function: string | null
	seniority: string
	providers: string[]
}

export interface CampaignCard {
	id: number
	companyId: number
	rank: number
	scoreDisplay: number
	personKey: string
	recipient: Candidate & { firstName: string | null; decidedBy: string; candidates: Candidate[] }
	address: AddressValue | null
	eligibility: 'eligible' | 'blocked'
	blockReason: string | null
	variant: 'A' | 'B' | null
	personalLine: string
	lineSource: 'llm' | 'template' | 'human'
	lineCites: string[]
	lineEvidence: { id: string; label: string; value: string; source: string }[]
	llmStatus: 'accepted' | 'rejected' | null
	llmRejections: { code: string; detail: string }[]
	llmModel: string | null
	status: string
	rejectReason: string | null
	approvedBy: string | null
	approvedAt: string | null
	mailId: string | null
	sendError: string | null
	submittedAt: string | null
	mailedAt: string | null
	statusChangedAt: string
	attempts: { n: number; outcome: 'ok' | 'timeout' | 'error'; httpStatus: number | null; delayMs: number | null }[]
}

export interface CampaignDetail {
	campaign: {
		id: number
		name: string
		status: string
		topN: number
		icpVersionId: number
		createdBy: string
		createdAt: string
		launchedAt: string | null
		launchedBy: string | null
	}
	cards: CampaignCard[]
	templates: { id: number; name: string; variant: 'A' | 'B'; body: string }[]
	summary: CampaignSummary
	activity: AuditEvent[]
}

const DECIDED_BY: Record<string, string> = {
	'only candidate': 'the only person listed at this company',
	function:
		'works in the most relevant function (operations, then fleet and plant, then procurement, then sustainability)',
	seniority: 'most senior in that function',
	corroboration: 'confirmed by more providers than the others',
	freshness: 'has the most recent record',
	'contact id': 'the earliest record (all else was equal)',
	'seeded history': 'from a past campaign',
}

const IN_FLIGHT = ['queued', 'submitted', 'printed', 'mailed']

const FILTERS: [string, string, (card: CampaignCard) => boolean][] = [
	['all', 'All', () => true],
	['draft', 'Drafts', (card) => card.status === 'draft'],
	['approved', 'Approved', (card) => card.status === 'approved'],
	['blocked', 'Blocked', (card) => card.eligibility === 'blocked' || card.status === 'blocked_at_send'],
	['rejected', 'Rejected', (card) => card.status === 'rejected'],
	['ai-rejected', 'AI line rejected', (card) => card.llmStatus === 'rejected'],
	['sent', 'Sent', (card) => card.submittedAt !== null],
]

export function CampaignPage() {
	const id = Number(useParams().id)
	const query = useQuery({
		queryKey: ['campaign', id],
		queryFn: () => api<CampaignDetail>(`/api/campaigns/${id}`),
		// Poll every second while any card is on its way, so webhook updates show within a couple of seconds.
		refetchInterval: (state) =>
			state.state.data?.cards.some((card) => IN_FLIGHT.includes(card.status)) ? 1000 : false,
	})
	return <QueryState query={query}>{(detail) => <CampaignView detail={detail} />}</QueryState>
}

function CampaignView({ detail }: { detail: CampaignDetail }) {
	const { campaign, summary } = detail
	const { data: user } = useSession()
	const userName = useUserName()
	const queryClient = useQueryClient()
	const [params, setParams] = useSearchParams()
	const filter = params.get('show') ?? 'all'
	const isLead = user?.role === 'lead'
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['campaign', campaign.id] })

	const [confirmingSend, setConfirmingSend] = useState(false)
	const send = useMutation({
		mutationFn: () => api<{ queued: number }>(`/api/campaigns/${campaign.id}/send`, { method: 'POST' }),
		onSuccess: () => setConfirmingSend(false),
		onSettled: refresh,
	})
	const approvedCount = detail.cards.filter((card) => card.status === 'approved').length
	const approveAll = useMutation({
		mutationFn: () => api<{ approved: number }>(`/api/campaigns/${campaign.id}/approve-eligible`, { method: 'POST' }),
		onSettled: refresh,
	})
	const drafts = detail.cards.filter((card) => card.status === 'draft').length
	const suppressed = Object.entries(summary.blocked)
		.filter(([reason]) => reason.startsWith('suppressed:'))
		.reduce((sum, [, n]) => sum + n, 0)
	const badAddress = Object.entries(summary.blocked)
		.filter(([reason]) => reason.startsWith('invalid_address:'))
		.reduce((sum, [, n]) => sum + n, 0)
	const show = (value: string) => setParams({ show: value })
	const visible = detail.cards.filter(FILTERS.find(([value]) => value === filter)?.[2] ?? (() => true))

	return (
		<div className="space-y-6">
			<div className="space-y-1">
				<p className="text-sm">
					<Link to="/campaigns" className="text-muted-foreground underline-offset-2 hover:underline">
						Campaigns
					</Link>
				</p>
				<h1 className="text-2xl font-semibold">{campaign.name}</h1>
				<p className="text-sm text-muted-foreground">
					Top {campaign.topN} by score with ICP version {campaign.icpVersionId} · built by{' '}
					{userName(campaign.createdBy)} on {formatDateTime(campaign.createdAt)}
					{campaign.launchedAt &&
						` · send launched by ${userName(campaign.launchedBy ?? '')} on ${formatDateTime(campaign.launchedAt)}`}
				</p>
			</div>

			<p className="text-sm">
				{summary.total} cards:{' '}
				<button type="button" className="underline underline-offset-2" onClick={() => show('all')}>
					{summary.eligible} eligible
				</button>
				,{' '}
				<button type="button" className="underline underline-offset-2" onClick={() => show('blocked')}>
					{summary.total - summary.eligible} blocked
				</button>{' '}
				({suppressed} suppressed, {badAddress} bad address) · variant A {summary.variants.A}, B {summary.variants.B}
				{summary.llmRejected > 0 && (
					<>
						{' · '}
						<button type="button" className="underline underline-offset-2" onClick={() => show('ai-rejected')}>
							{summary.llmRejected} AI lines rejected (template used)
						</button>
					</>
				)}
			</p>

			<div className="flex flex-wrap items-center gap-2">
				{FILTERS.map(([value, label, predicate]) => (
					<Button key={value} size="sm" variant={filter === value ? 'default' : 'outline'} onClick={() => show(value)}>
						{label} ({detail.cards.filter(predicate).length})
					</Button>
				))}
				<span className="flex-1" />
				{isLead ? (
					<>
						<Button
							variant="outline"
							disabled={drafts === 0 || approveAll.isPending}
							onClick={() => approveAll.mutate()}
						>
							Approve all eligible drafts (
							{detail.cards.filter((card) => card.status === 'draft' && card.eligibility === 'eligible').length})
						</Button>
						<Button disabled={approvedCount === 0} onClick={() => setConfirmingSend(true)}>
							Send {approvedCount} approved
						</Button>
					</>
				) : (
					<p className="text-sm text-muted-foreground">Only a sales lead can approve cards and send.</p>
				)}
			</div>
			{approveAll.isError && <p className="text-sm text-destructive">{approveAll.error.message}</p>}
			<Dialog open={confirmingSend} onOpenChange={setConfirmingSend}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Send {approvedCount} postcards?</DialogTitle>
						<DialogDescription>
							They go to the printer now. Each card is checked again for opt-outs and recent mailings just before it is
							sent, and is blocked rather than sent if anything changed. This cannot be undone.
						</DialogDescription>
					</DialogHeader>
					{send.isError && <p className="text-sm text-destructive">{send.error.message}</p>}
					<DialogFooter>
						<Button variant="outline" onClick={() => setConfirmingSend(false)}>
							Cancel
						</Button>
						<Button disabled={send.isPending} onClick={() => send.mutate()}>
							{send.isPending ? 'Queuing…' : `Send ${approvedCount}`}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{visible.length === 0 ? (
				<p className="text-sm text-muted-foreground">No cards here.</p>
			) : (
				<div className="grid gap-4 lg:grid-cols-2">
					{visible.map((card) => (
						<PostcardItem
							key={card.id}
							card={card}
							template={detail.templates.find((template) => template.variant === card.variant)}
							isLead={isLead}
							onChange={refresh}
						/>
					))}
				</div>
			)}

			<section className="space-y-2">
				<h2 className="text-lg font-semibold">Activity</h2>
				<ActivityTimeline events={detail.activity} />
			</section>
		</div>
	)
}

function render(body: string, card: CampaignCard, company: string) {
	return body
		.replace('{{first_name}}', card.recipient.firstName ?? 'there')
		.replace('{{personal_line}}', card.personalLine)
		.replace('{{company}}', company)
}

function PostcardItem({
	card,
	template,
	isLead,
	onChange,
}: {
	card: CampaignCard
	template?: { body: string }
	isLead: boolean
	onChange: () => Promise<void>
}) {
	const userName = useUserName()
	const [rejecting, setRejecting] = useState(false)
	const [editing, setEditing] = useState(false)
	const [text, setText] = useState(card.personalLine)
	const company = card.lineEvidence.find((item) => item.label === 'company')?.value ?? `Company #${card.companyId}`
	const approve = useMutation({
		mutationFn: () => api(`/api/cards/${card.id}/approve`, { method: 'POST' }),
		onSettled: onChange,
	})
	const saveLine = useMutation({
		mutationFn: () => api(`/api/cards/${card.id}/line`, { method: 'POST', json: { text } }),
		onSuccess: async () => {
			setEditing(false)
			await onChange()
		},
	})
	const editable = card.status === 'draft' || card.status === 'approved'

	return (
		<article aria-label={`Card for ${company}`} className="space-y-3 rounded-lg border p-4">
			<header className="flex flex-wrap items-start justify-between gap-2">
				<div>
					<p className="font-medium">
						#{card.rank}{' '}
						<Link to={`/companies/${card.companyId}`} className="underline-offset-2 hover:underline">
							{company}
						</Link>
					</p>
					<p className="text-xs text-muted-foreground">
						Score {card.scoreDisplay}
						{card.variant && ` · template ${card.variant}`}
					</p>
				</div>
				<div className="flex flex-wrap gap-1">
					<Badge
						variant={
							card.status === 'approved' || card.submittedAt
								? 'default'
								: card.status === 'draft'
									? 'outline'
									: 'secondary'
						}
					>
						{CARD_STATUS_LABELS[card.status] ?? card.status}
					</Badge>
					{card.blockReason && (
						<Badge variant="destructive">{BLOCK_REASON_LABELS[card.blockReason] ?? card.blockReason}</Badge>
					)}
				</div>
			</header>

			<div className="grid gap-3 rounded-md bg-muted/50 p-3 text-sm sm:grid-cols-2">
				<div className="whitespace-pre-line">
					{template ? (
						render(template.body, card, company)
					) : (
						<span className="text-muted-foreground">Not printed.</span>
					)}
				</div>
				<div className="border-l pl-3">
					<p className="font-medium">{card.recipient.fullName}</p>
					<p>{card.recipient.title}</p>
					<p>{company}</p>
					<p className="text-muted-foreground">{formatAddress(card.address)}</p>
				</div>
			</div>

			<div className="space-y-1 text-xs">
				{card.lineSource === 'human' ? (
					<Badge variant="outline">Line written by a person</Badge>
				) : card.llmStatus === 'accepted' ? (
					<Badge variant="secondary">AI line, checked against the evidence</Badge>
				) : card.llmStatus === 'rejected' ? (
					<Badge variant="destructive">
						AI line rejected: {card.llmRejections.map((rejection) => rejection.detail).join('; ')}. Template used.
					</Badge>
				) : null}
				{card.eligibility === 'blocked' && (
					<p className="text-muted-foreground">No line was written: this card is blocked.</p>
				)}
				{card.eligibility === 'eligible' && card.lineCites.length > 0 && (
					<p className="text-muted-foreground">
						Line uses:{' '}
						{card.lineCites
							.map((cite) => card.lineEvidence.find((item) => item.id === cite))
							.filter(Boolean)
							.map((item) => `${item!.label} (${item!.source})`)
							.join(', ')}
					</p>
				)}
				{card.rejectReason && <p>Rejected: {card.rejectReason}</p>}
				{card.mailId && (
					<p>
						Mail id <span className="font-mono">{card.mailId}</span>, submitted {formatDateTime(card.submittedAt)}
						{card.mailedAt && `, mailed ${formatDateTime(card.mailedAt)}`}
					</p>
				)}
				{card.attempts.length > 0 && (
					<p className="text-muted-foreground">
						{card.attempts.length === 1 ? '1 attempt' : `${card.attempts.length} attempts`}:{' '}
						{card.attempts
							.map(
								(attempt) =>
									`${attempt.outcome}${attempt.httpStatus ? ` (${attempt.httpStatus})` : ''}${attempt.delayMs !== null ? `, waited ${attempt.delayMs} ms` : ''}`,
							)
							.join(' → ')}
					</p>
				)}
				{card.sendError && (
					<p className="text-destructive">
						Not sent: {card.sendError}. A person needs to decide what to do with this card.
					</p>
				)}
				{card.approvedBy && card.approvedAt && (
					<p className="text-muted-foreground">
						Approved by {userName(card.approvedBy)} on {formatDateTime(card.approvedAt)}
					</p>
				)}
			</div>

			<details className="text-xs">
				<summary className="cursor-pointer">Why this person</summary>
				<p className="mt-1">
					{card.recipient.fullName}: {DECIDED_BY[card.recipient.decidedBy] ?? card.recipient.decidedBy}. Known to{' '}
					{card.recipient.providers
						.map((provider) => PROVIDER_LABELS[provider as ProviderName] ?? provider)
						.join(' and ')}
					.
				</p>
				{card.recipient.candidates.length > 1 && (
					<ul className="mt-1 space-y-0.5 text-muted-foreground">
						{card.recipient.candidates.slice(1).map((candidate) => (
							<li key={candidate.personKey}>
								Not chosen: {candidate.fullName}, {candidate.title} ({candidate.function ?? 'other function'},{' '}
								{candidate.seniority.replace('_', ' ')})
							</li>
						))}
					</ul>
				)}
				{card.blockReason && <p className="mt-1">This card is blocked. We do not send it to someone else instead.</p>}
			</details>

			{editable && (
				<div className="flex flex-wrap gap-2">
					{isLead && card.status === 'draft' && card.eligibility === 'eligible' && (
						<Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate()}>
							Approve
						</Button>
					)}
					<Button size="sm" variant="outline" onClick={() => setEditing(true)}>
						Edit line
					</Button>
					{card.status === 'draft' && (
						<Button size="sm" variant="outline" onClick={() => setRejecting(true)}>
							Reject
						</Button>
					)}
				</div>
			)}
			{approve.isError && <p className="text-sm text-destructive">{approve.error.message}</p>}

			<ReasonDialog
				open={rejecting}
				onOpenChange={setRejecting}
				title="Reject this card"
				description={`${card.recipient.fullName} at ${company} will not get a postcard from this campaign.`}
				confirmLabel="Reject"
				onConfirm={async (reason) => {
					await api(`/api/cards/${card.id}/reject`, { method: 'POST', json: { reason } })
					await onChange()
				}}
			/>
			<Dialog open={editing} onOpenChange={setEditing}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Edit the personal line</DialogTitle>
						<DialogDescription>
							{card.status === 'approved'
								? 'This card is approved. Saving a new line sends it back to draft for approval.'
								: 'Up to 200 characters, no contact details.'}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-1">
						<Label htmlFor={`line-${card.id}`}>Line ({text.trim().length}/200)</Label>
						<Textarea id={`line-${card.id}`} value={text} onChange={(event) => setText(event.target.value)} />
					</div>
					{saveLine.isError && <p className="text-sm text-destructive">{saveLine.error.message}</p>}
					<DialogFooter>
						<Button variant="outline" onClick={() => setEditing(false)}>
							Cancel
						</Button>
						<Button disabled={saveLine.isPending || text.trim() === ''} onClick={() => saveLine.mutate()}>
							Save line
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</article>
	)
}
