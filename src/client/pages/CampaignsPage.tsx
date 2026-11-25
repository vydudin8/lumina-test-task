import { NumberInput } from '#client/components/NumberInput.tsx'
import { Pager } from '#client/components/Pager.tsx'
import { QueryState } from '#client/components/QueryState.tsx'
import { Badge } from '#client/components/ui/badge.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '#client/components/ui/card.tsx'
import { Checkbox } from '#client/components/ui/checkbox.tsx'
import { Input } from '#client/components/ui/input.tsx'
import { Label } from '#client/components/ui/label.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#client/components/ui/select.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { toast } from '#client/components/ui/toast.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '#client/components/ui/tooltip.tsx'
import { campaignStage, type CampaignSummary } from '#client/domain/campaigns.ts'
import { useUserName } from '#client/domain/session.ts'
import { api } from '#client/lib/api.ts'
import { formatDateTime } from '#client/lib/format.ts'
import { useCursorPages } from '#client/lib/lists.ts'
import { cn } from '#client/lib/utils.ts'
import { MIN_SAMPLE_PER_VARIANT } from '#common/settings.ts'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Info, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

interface CampaignRow {
	id: number
	name: string
	topN: number
	icpVersionId: number
	templateAId: number
	templateBId: number | null
	createdBy: string
	createdAt: string
	launchedAt: string | null
	summary: CampaignSummary
}

interface Template {
	id: number
	name: string
	body: string
}

interface CampaignsResponse {
	total: number
	pageSize: number
	nextCursor: string | null
	campaigns: CampaignRow[]
}

export function CampaignsPage() {
	const pages = useCursorPages('campaigns', '')
	const search = new URLSearchParams()
	if (pages.cursor) search.set('cursor', pages.cursor)
	const list = useQuery({
		queryKey: ['campaigns', search.toString()],
		queryFn: () => api<CampaignsResponse>(`/api/campaigns?${search.toString()}`),
		placeholderData: keepPreviousData,
	})
	const userName = useUserName()
	const templates = useTemplates()
	const nameOf = (id: number) =>
		templates.data?.templates.find((template) => template.id === id)?.name ?? `Template #${id}`

	return (
		<div className="space-y-8">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
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
					{({ campaigns, total, pageSize, nextCursor }) => (
						<div className="space-y-4">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Campaign</TableHead>
										<TableHead className="text-center">Templates</TableHead>
										<TableHead className="text-center">Status</TableHead>
										<TableHead className="text-center">Cards</TableHead>
										<TableHead className="text-center">Approved</TableHead>
										<TableHead className="text-center">Sent</TableHead>
										<TableHead className="text-center">Delivered</TableHead>
										<TableHead>Created</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{campaigns.map(({ summary, ...campaign }) => {
										const stage = campaignStage(summary)
										return (
											// A cell is a main line, sometimes with a muted second line; every two-line cell is the same height,
											// so with middle alignment both lines run straight across and a lone value sits between them.
											<TableRow key={campaign.id}>
												<TableCell>
													<Link to={`/campaigns/${campaign.id}`} className="link font-medium">
														{campaign.name}
													</Link>
													<div className="text-xs text-muted-foreground">
														Top {campaign.topN}, ICP version {campaign.icpVersionId}
													</div>
												</TableCell>
												<TableCell className="text-center">
													{campaign.templateBId === null ? 'One template' : 'A/B test'}
													<div className="text-xs text-muted-foreground">
														{campaign.templateBId === null
															? nameOf(campaign.templateAId)
															: `${nameOf(campaign.templateAId)} vs ${nameOf(campaign.templateBId)}`}
													</div>
												</TableCell>
												<TableCell className="text-center">
													{/* py-px: the badge is exactly one text line tall, so the line under it lines up with its neighbours. */}
													<Badge variant={stage.tone} className="mx-auto flex py-px">
														{stage.label}
													</Badge>
													{/* A sent campaign's delivered and returned counts have their own column. */}
													{stage.note && stage.label !== 'Sent' && (
														<div className="text-xs text-muted-foreground">{stage.note}</div>
													)}
												</TableCell>
												<TableCell className="text-center tabular-nums">
													{summary.total}
													{summary.total > summary.eligible && (
														<div className="text-xs text-muted-foreground">
															{summary.total - summary.eligible} blocked
														</div>
													)}
												</TableCell>
												<TableCell className="text-center tabular-nums">
													{summary.approved} <span className="text-muted-foreground">of {summary.eligible}</span>
												</TableCell>
												<TableCell className="text-center tabular-nums">{summary.sent}</TableCell>
												<TableCell className="text-center tabular-nums">
													{summary.delivered}
													{summary.returned > 0 && (
														<div className="text-xs text-muted-foreground">{summary.returned} returned</div>
													)}
												</TableCell>
												<TableCell>
													{formatDateTime(campaign.createdAt)}
													<div className="text-xs text-muted-foreground">{userName(campaign.createdBy)}</div>
												</TableCell>
											</TableRow>
										)
									})}
								</TableBody>
							</Table>
							<Pager
								page={pages.page}
								pageSize={pageSize}
								shown={campaigns.length}
								total={total}
								onFirst={pages.page > 0 ? pages.first : null}
								onPrevious={pages.page > 0 ? pages.previous : null}
								onNext={nextCursor ? () => pages.next(nextCursor) : null}
							/>
						</div>
					)}
				</QueryState>
			</section>
		</div>
	)
}

const useTemplates = () =>
	useQuery({ queryKey: ['templates'], queryFn: () => api<{ templates: Template[] }>('/api/templates') })

function CampaignBuilder() {
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	const templates = useTemplates()
	const [name, setName] = useState(
		`Top 50, ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
	)
	const [topN, setTopN] = useState('50')
	const [templateA, setTemplateA] = useState<string>('')
	const [templateB, setTemplateB] = useState<string>('')
	const [abTest, setAbTest] = useState(true)
	// One key per form submission: a double click or a retried request returns the same campaign.
	const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

	// Any template can fill either slot; the defaults are the first two, and a slot never offers the other's pick.
	const all = templates.data?.templates ?? []
	const chosenA = templateA || String(all[0]?.id ?? '')
	const chosenB = templateB || String(all.find((template) => String(template.id) !== chosenA)?.id ?? '')
	const options = (variant: 'A' | 'B') =>
		all.filter((template) =>
			variant === 'A' && !abTest ? true : String(template.id) !== (variant === 'A' ? chosenB : chosenA),
		)
	// The smaller template gets at most half the companies, rounded down: 199 leaves it 99, so 200 is the first safe size.
	const smaller = Math.floor(Number(topN) / 2)
	const larger = Math.ceil(Number(topN) / 2)
	const tooSmall = abTest && Number(topN) >= 1 && smaller < MIN_SAMPLE_PER_VARIANT

	const build = useMutation({
		mutationFn: () =>
			api<{ campaign: { id: number } }>('/api/campaigns', {
				method: 'POST',
				headers: { 'Idempotency-Key': idempotencyKey },
				json: {
					name,
					topN: Number(topN),
					templateAId: Number(chosenA),
					templateBId: abTest ? Number(chosenB) : null,
				},
			}),
		onSuccess: async ({ campaign }) => {
			toast({ title: 'Campaign built', description: name })
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
					{/* flex gap, not space-y: Radix Select adds a hidden <select> that would push its column up. */}
					<div className="flex flex-col gap-1">
						<Label htmlFor="campaign-name">Name</Label>
						<Input id="campaign-name" value={name} onChange={(event) => setName(event.target.value)} />
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="campaign-top">Top companies</Label>
						<NumberInput id="campaign-top" max={500} value={topN} onValueChange={setTopN} />
					</div>
					{(['A', 'B'] as const).map((variant) => (
						<div key={variant} className="flex flex-col gap-1">
							<Label htmlFor={`campaign-template-${variant}`}>Template {variant}</Label>
							<Select
								disabled={variant === 'B' && !abTest}
								value={variant === 'A' ? chosenA : abTest ? chosenB : ''}
								onValueChange={variant === 'A' ? setTemplateA : setTemplateB}
							>
								<SelectTrigger id={`campaign-template-${variant}`} className="w-full">
									<SelectValue placeholder="Not used without an A/B test" />
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
					<Button
						type="submit"
						disabled={build.isPending || !chosenA || (abTest && !chosenB) || !name.trim() || !(Number(topN) >= 1)}
					>
						{build.isPending ? 'Drafting cards…' : 'Build campaign'}
					</Button>
				</form>
				{build.isError && <p className="mt-2 text-sm text-destructive">{build.error.message}</p>}
				<div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
					<div className="flex items-center gap-2">
						<Checkbox id="campaign-ab" checked={abTest} onCheckedChange={(checked) => setAbTest(checked === true)} />
						<Label htmlFor="campaign-ab">A/B test</Label>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label="About A/B tests"
									className={cn(
										'rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
										tooSmall ? 'text-warning' : 'text-muted-foreground hover:text-foreground',
									)}
								>
									{tooSmall ? <TriangleAlert className="size-4" /> : <Info className="size-4" />}
								</button>
							</TooltipTrigger>
							<TooltipContent className="max-w-72">
								{tooSmall
									? `With the top ${topN}, each template gets not more than ${larger} cards. Telling two templates apart takes at least ${MIN_SAMPLE_PER_VARIANT} sent cards each, so this split will not show a winner. Pick at least ${MIN_SAMPLE_PER_VARIANT * 2} companies, or untick A/B test.`
									: `Splits eligible cards between two templates and compares replies, visits and meetings. Telling them apart takes at least ${MIN_SAMPLE_PER_VARIANT} sent cards per template.${abTest && smaller >= MIN_SAMPLE_PER_VARIANT ? ` With the top ${topN}, each template gets up to ${larger} cards, enough for a reliable comparison.` : ''}`}
							</TooltipContent>
						</Tooltip>
					</div>
					<p className="text-xs text-muted-foreground">
						{abTest
							? 'Uses the current ICP. Eligible cards alternate between the two templates in rank order, so both get a similar mix of scores.'
							: 'Uses the current ICP. Every eligible card gets template A.'}
					</p>
				</div>
			</CardContent>
		</Card>
	)
}
