import { api } from '#client/api.ts'
import { QueryState } from '#client/components/QueryState.tsx'
import { Button } from '#client/components/ui/button.tsx'
import { Input } from '#client/components/ui/input.tsx'
import { Label } from '#client/components/ui/label.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#client/components/ui/table.tsx'
import { formatDate, formatDateTime } from '#client/format.ts'
import { useUserName } from '#client/session.ts'
import { CARD_STATUS_LABELS } from '#common/settings.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'

interface SuppressionsResponse {
	optOuts: {
		id: number
		reason: string
		source: string | null
		createdBy: string
		at: string
		person: { fullName: string | null; title: string | null } | null
	}[]
	recentlyMailed: {
		cardId: number
		personKey: string
		fullName: string | null
		submittedAt: string
		until: string
		status: string
		campaignId: number
		campaignName: string
	}[]
	windowDays: number
}

export function SuppressionsPage() {
	const queryClient = useQueryClient()
	const userName = useUserName()
	const query = useQuery({ queryKey: ['suppressions'], queryFn: () => api<SuppressionsResponse>('/api/suppressions') })
	const [email, setEmail] = useState('')
	const [source, setSource] = useState('')
	const add = useMutation({
		mutationFn: () => api<{ added: boolean }>('/api/suppressions', { method: 'POST', json: { email, source } }),
		onSuccess: async () => {
			setEmail('')
			setSource('')
			await queryClient.invalidateQueries()
		},
	})

	return (
		<div className="space-y-8">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold">Suppression list</h1>
				<p className="max-w-3xl text-muted-foreground">
					Nobody here gets a postcard. Opt-outs are permanent and are stored as a hash of the email address only, so
					they still apply if the person's record is deleted. Anyone sent a card in the last{' '}
					{query.data?.windowDays ?? 90} days is also held back; that hold ends by itself.
				</p>
			</div>

			<form
				className="flex flex-wrap items-end gap-3"
				onSubmit={(event) => {
					event.preventDefault()
					add.mutate()
				}}
			>
				<div className="space-y-1">
					<Label htmlFor="optout-email">Email address</Label>
					<Input
						id="optout-email"
						type="email"
						className="w-72"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="optout-source">How they asked</Label>
					<Input
						id="optout-source"
						className="w-56"
						placeholder="e.g. phone call"
						value={source}
						onChange={(event) => setSource(event.target.value)}
					/>
				</div>
				<Button type="submit" disabled={!email.trim() || add.isPending}>
					Add opt-out
				</Button>
				{add.isError && <p className="text-sm text-destructive">{add.error.message}</p>}
				{add.data && (
					<p className="text-sm text-muted-foreground">{add.data.added ? 'Added.' : 'Already on the list.'}</p>
				)}
			</form>

			<QueryState query={query}>
				{(data) => (
					<>
						<section className="space-y-2">
							<h2 className="text-lg font-semibold">Opt-outs ({data.optOuts.length})</h2>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Person</TableHead>
										<TableHead>How they asked</TableHead>
										<TableHead>Added by</TableHead>
										<TableHead>Date</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.optOuts.map((row) => (
										<TableRow key={row.id}>
											<TableCell>
												{row.person ? (
													`${row.person.fullName}${row.person.title ? `, ${row.person.title}` : ''}`
												) : (
													<span className="text-muted-foreground">Not in current provider data</span>
												)}
											</TableCell>
											<TableCell>{row.source ?? '—'}</TableCell>
											<TableCell>{userName(row.createdBy)}</TableCell>
											<TableCell>{formatDateTime(row.at)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</section>
						<section className="space-y-2">
							<h2 className="text-lg font-semibold">
								Mailed in the last {data.windowDays} days ({data.recentlyMailed.length})
							</h2>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Person</TableHead>
										<TableHead>Campaign</TableHead>
										<TableHead>Sent</TableHead>
										<TableHead>Status</TableHead>
										<TableHead>Held until</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.recentlyMailed.map((row) => (
										<TableRow key={row.cardId}>
											<TableCell>{row.fullName}</TableCell>
											<TableCell>
												<Link to={`/campaigns/${row.campaignId}`} className="underline-offset-2 hover:underline">
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
						</section>
					</>
				)}
			</QueryState>
		</div>
	)
}
