import { actionLabel } from '#client/domain/audit.ts'
import type { Contribution } from '#client/domain/scores.ts'
import type { AddressValue } from '#client/lib/format.ts'
import { useState } from 'react'

export interface CampaignSummary {
	total: number
	eligible: number
	byStatus: Record<string, number>
	blocked: Record<string, number>
	llmRejected: number
	blockedAtSend: number
	variants: { A: number; B: number }
	// Cumulative: a card approved and then sent still counts as approved.
	approved: number
	toReview: number
	// Eligible cards the "write lines" job has not reached yet; they cannot be approved.
	linesPending: number
	// The "write lines" job stopped with an error; the pending cards need their lines written by hand.
	linesFailed: boolean
	ready: number
	sent: number
	delivered: number
	returned: number
	needsAttention: number
}

export interface Template {
	id: number
	name: string
	body: string
}

export interface CampaignDetail {
	campaign: {
		id: number
		name: string
		topN: number
		icpVersionId: number
		templateAId: number
		templateBId: number | null
		createdBy: string
		createdAt: string
		launchedAt: string | null
		launchedBy: string | null
	}
	templates: Template[]
	summary: CampaignSummary
	// The latest "write lines" job; null when no card needed one.
	linesJob: { status: 'queued' | 'running' | 'done' | 'failed'; error: string | null } | null
}

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
	companyName: string | null
	rank: number
	// Exact decimal and rule breakdown as scored when the campaign was built; empty on cards seeded from past campaigns.
	score: string
	scoreDisplay: number
	contributions: Contribution[]
	personKey: string | null
	// Null when no provider lists anyone at the company: the card is blocked as 'no_contact'.
	recipient: (Candidate & { firstName: string | null; decidedBy: string; candidates: Candidate[] }) | null
	address: AddressValue | null
	// Null on cards seeded from past campaigns.
	addressSource: { provider: string | null; conflict: boolean; chosenBy: string | null } | null
	eligibility: 'eligible' | 'blocked'
	blockReason: string | null
	variant: 'A' | 'B' | null
	// Null until the campaign's "write lines" job reaches the card; it cannot be approved before.
	personalLine: string | null
	lineSource: 'llm' | 'template' | 'human' | null
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

export const companyOf = (card: CampaignCard) =>
	card.companyName ?? card.lineEvidence.find((item) => item.label === 'company')?.value ?? `Company #${card.companyId}`

export type Tone = 'warning' | 'info' | 'success' | 'destructive' | 'secondary'

// The one line that says where a campaign is, most urgent first: a person's attention, then review, then sending.
export function campaignStage(summary: CampaignSummary): { label: string; tone: Tone; note: string | null } {
	const queued = summary.byStatus.queued ?? 0
	if (summary.needsAttention > 0)
		return { label: 'Needs attention', tone: 'destructive', note: `${summary.needsAttention} not confirmed or failed` }
	if (queued > 0) return { label: 'Sending', tone: 'info', note: `${queued} in the queue` }
	if (summary.linesPending > 0 && summary.linesFailed)
		return {
			label: 'Lines failed',
			tone: 'destructive',
			note: `${summary.linesPending} cards need a line written by hand`,
		}
	if (summary.linesPending > 0)
		return {
			label: 'Writing lines',
			tone: 'info',
			note: `${summary.eligible - summary.linesPending} of ${summary.eligible} personal lines written`,
		}
	if (summary.toReview > 0) return { label: 'In review', tone: 'warning', note: `${summary.toReview} to review` }
	if (summary.ready > 0) return { label: 'Ready to send', tone: 'info', note: `${summary.ready} approved, not sent` }
	if (summary.sent > 0) {
		const returned = summary.returned > 0 ? `, ${summary.returned} returned` : ''
		return { label: 'Sent', tone: 'success', note: `${summary.delivered} delivered${returned}` }
	}
	return { label: 'Nothing to send', tone: 'secondary', note: null }
}

const ATTENTION = ['failed', 'unconfirmed']

// The Status filter's choices; the server decides which cards each one holds.
export const CARD_VIEWS: readonly (readonly [value: string, label: string])[] = [
	['all', 'All'],
	['review', 'To review'],
	['approved', 'Approved'],
	['sent', 'Sent'],
	['delivered', 'Delivered'],
	['attention', 'Needs attention'],
	['blocked', 'Blocked'],
	['rejected', 'Rejected'],
	['ai-rejected', 'AI line rejected'],
]

// Open by default only where a person has something to decide; everything else starts as one line.
export const defaultExpanded = (card: { status: string }) => card.status === 'draft' || ATTENTION.includes(card.status)

export const CARD_TONE: Record<string, Tone> = {
	draft: 'warning',
	approved: 'info',
	queued: 'info',
	submitted: 'info',
	printed: 'info',
	mailed: 'info',
	delivered: 'success',
	returned: 'destructive',
	rejected: 'secondary',
	blocked: 'destructive',
	blocked_at_send: 'destructive',
	failed: 'destructive',
	unconfirmed: 'destructive',
}

const GROUP_LABELS: Record<string, (count: number) => string> = {
	'card.approved': (n) => `${n} cards approved`,
	'card.rejected': (n) => `${n} cards rejected`,
	'card.line_edited': (n) => `${n} personal lines edited`,
	'card.submitted': (n) => `${n} cards sent to print`,
	'card.blocked_at_send': (n) => `${n} cards blocked at send`,
	'card.failed': (n) => `${n} cards failed to send`,
	'card.send_unconfirmed': (n) => `${n} sends not confirmed`,
	'card.send_retried': (n) => `${n} sends retried`,
	'llm.output_rejected': (n) => `${n} AI lines rejected`,
	'outcome.logged': (n) => `${n} outcomes logged`,
}

// A history entry that stands for several events of one action, e.g. a bulk approval, says how many.
export const groupLabel = (action: string, count: number) =>
	count === 1 ? actionLabel(action) : (GROUP_LABELS[action]?.(count) ?? `${actionLabel(action)} ×${count}`)

// The history sheet and its filters live in the URL (`history`, `h*`), so Back closes it and a reload keeps it open.
export const HISTORY_PARAMS = { history: '', hAction: '', hCard: '', hFrom: '', hTo: '', event: '' }
// Opens the sheet on one card's entries only.
export const cardHistoryParams = (cardId: number) => ({ ...HISTORY_PARAMS, history: '1', hCard: String(cardId) })

const readChoice = (key: string) => {
	try {
		return localStorage.getItem(key)
	} catch {
		return null
	}
}

// Shown or hidden is remembered per user and campaign in this browser, so it survives a reload and signing in again.
// Until someone picks, results show once a card has gone to the printer.
export function useResultsShown(userId: string, campaignId: number, anySent: boolean) {
	const key = `campaign-results:${userId}:${campaignId}`
	const [state, setState] = useState(() => ({ key, choice: readChoice(key) }))
	if (state.key !== key) setState({ key, choice: readChoice(key) })
	const shown = state.choice === null ? anySent : state.choice === 'shown'
	const toggle = () => {
		const choice = shown ? 'hidden' : 'shown'
		try {
			localStorage.setItem(key, choice)
		} catch {
			// Not remembered; the toggle still works until the page reloads.
		}
		setState({ key, choice })
	}
	return [shown, toggle] as const
}
