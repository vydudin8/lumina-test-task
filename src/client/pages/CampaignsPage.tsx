import { api } from '#client/api.ts'
import { QueryState } from '#client/components/QueryState.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '#client/components/ui/card.tsx'
import { Input } from '#client/components/ui/input.tsx'
import { Label } from '#client/components/ui/label.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#client/components/ui/select.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { formatDateTime } from '#client/format.ts'
import { useUserName } from '#client/session.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

export interface CampaignSummary {
	total: number
	eligible: number
	byStatus: Record<string, number>
	blocked: Record<string, number>
	llmRejected: number
	variants: { A: number; B: number }
}

interface CampaignRow {
	id: number
	name: string
	status: string
	topN: number
	icpVersionId: number
	createdBy: string
	createdAt: string
	launchedAt: string | null
	summary: CampaignSummary
}

interface Template {
	id: number
	name: string
	variant: 'A' | 'B'
	body: string
}

const IN_FLIGHT = ['queued', 'submitted', 'printed', 'mailed', 'delivered', 'returned']

export function CampaignsPage() {
	const list = useQuery({ queryKey: ['campaigns'], queryFn: () => api<{ campaigns: CampaignRow[] }>('/api/campaigns') })
	const userName = useUserName()

	return (
		<div className="space-y-8">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold">Campaigns</h1>
				<p className="max-w-3xl text-muted-foreground">
					A campaign takes the top companies by score and drafts one postcard each, addressed to one person at the
					company office. Cards for people who opted out, were mailed in the last 90 days or have a bad address are
					blocked, never redirected to a colleague.
				</p>
			</div>
			<CampaignBuilder />
			<section className="space-y-2">
				<h2 className="text-lg font-semibold">All campaigns</h2>
				<QueryState query={list} empty="No campaigns yet." isEmpty={(data) => data.campaigns.length === 0}>
					{({ campaigns }) => (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Campaign</TableHead>
									<TableHead>Created</TableHead>
									<TableHead className="text-right">Cards</TableHead>
									<TableHead className="text-right">Eligible</TableHead>
									<TableHead className="text-right">Approved</TableHead>
									<TableHead className="text-right">Sent</TableHead>
									<TableHead>Status</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{campaigns.map((campaign) => (
									<TableRow key={campaign.id}>
										<TableCell>
											<Link to={`/campaigns/${campaign.id}`} className="font-medium underline-offset-2 hover:underline">
												{campaign.name}
											</Link>
											<div className="text-xs text-muted-foreground">
												Top {campaign.topN}, ICP version {campaign.icpVersionId}
											</div>
										</TableCell>
										<TableCell>
											{formatDateTime(campaign.createdAt)}
											<div className="text-xs text-muted-foreground">{userName(campaign.createdBy)}</div>
										</TableCell>
										<TableCell className="text-right tabular-nums">{campaign.summary.total}</TableCell>
										<TableCell className="text-right tabular-nums">{campaign.summary.eligible}</TableCell>
										<TableCell className="text-right tabular-nums">{campaign.summary.byStatus.approved ?? 0}</TableCell>
										<TableCell className="text-right tabular-nums">
											{IN_FLIGHT.reduce((sum, status) => sum + (campaign.summary.byStatus[status] ?? 0), 0)}
										</TableCell>
										<TableCell>
											{campaign.status === 'draft' ? 'Reviewing' : campaign.status === 'sending' ? 'Sending' : 'Sent'}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</QueryState>
			</section>
		</div>
	)
}

function CampaignBuilder() {
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	const templates = useQuery({
		queryKey: ['templates'],
		queryFn: () => api<{ templates: Template[] }>('/api/templates'),
	})
	const [name, setName] = useState(
		`Top 50, ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
	)
	const [topN, setTopN] = useState(50)
	const [templateA, setTemplateA] = useState<string>('')
	const [templateB, setTemplateB] = useState<string>('')
	// One key per form submission: a double click or a retried request returns the same campaign.
	const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

	const options = (variant: 'A' | 'B') =>
		templates.data?.templates.filter((template) => template.variant === variant) ?? []
	const chosenA = templateA || String(options('A')[0]?.id ?? '')
	const chosenB = templateB || String(options('B')[0]?.id ?? '')

	const build = useMutation({
		mutationFn: () =>
			api<{ campaign: { id: number } }>('/api/campaigns', {
				method: 'POST',
				headers: { 'Idempotency-Key': idempotencyKey },
				json: { name, topN, templateAId: Number(chosenA), templateBId: Number(chosenB) },
			}),
		onSuccess: async ({ campaign }) => {
			setIdempotencyKey(crypto.randomUUID())
			await queryClient.invalidateQueries({ queryKey: ['campaigns'] })
			await navigate(`/campaigns/${campaign.id}`)
		},
	})

	return (
		<Card>
			<CardHeader>
				<CardTitle>Build a campaign</CardTitle>
			</CardHeader>
			<CardContent>
				<form
					className="grid gap-4 md:grid-cols-[2fr_1fr_2fr_2fr_auto] md:items-end"
					onSubmit={(event) => {
						event.preventDefault()
						build.mutate()
					}}
				>
					<div className="space-y-1">
						<Label htmlFor="campaign-name">Name</Label>
						<Input id="campaign-name" value={name} onChange={(event) => setName(event.target.value)} />
					</div>
					<div className="space-y-1">
						<Label htmlFor="campaign-top">Top companies</Label>
						<Input
							id="campaign-top"
							type="number"
							min={1}
							max={500}
							value={topN}
							onChange={(event) => setTopN(Number(event.target.value))}
						/>
					</div>
					{(['A', 'B'] as const).map((variant) => (
						<div key={variant} className="space-y-1">
							<Label>Template {variant}</Label>
							<Select
								value={variant === 'A' ? chosenA : chosenB}
								onValueChange={variant === 'A' ? setTemplateA : setTemplateB}
							>
								<SelectTrigger aria-label={`Template ${variant}`} className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{options(variant).map((template) => (
										<SelectItem key={template.id} value={String(template.id)}>
											{template.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					))}
					<Button type="submit" disabled={build.isPending || !chosenA || !chosenB || !name.trim()}>
						{build.isPending ? 'Drafting cards…' : 'Build campaign'}
					</Button>
				</form>
				{build.isError && <p className="mt-2 text-sm text-destructive">{build.error.message}</p>}
				<p className="mt-3 text-xs text-muted-foreground">
					Uses the current ICP. Eligible cards alternate between template A and B in rank order, so both get a similar
					mix of scores.
				</p>
			</CardContent>
		</Card>
	)
}
