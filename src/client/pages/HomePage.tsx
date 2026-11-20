import { useSession } from '#client/session.ts'

export function HomePage() {
	const { data: user } = useSession()

	return (
		<div className="space-y-2">
			<h1 className="text-2xl font-semibold">Outbound targeting and postcards</h1>
			<p className="text-muted-foreground">
				{user
					? `Signed in as ${user.name}.`
					: 'Choose who you are in the header. Only a sales lead can approve cards and launch a send.'}
			</p>
		</div>
	)
}
