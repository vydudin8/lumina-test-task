import { Badge } from '#client/components/ui/badge.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#client/components/ui/select.tsx'
import { roleLabels, usePickUser, useSession, useUsers } from '#client/session.ts'
import { NavLink } from 'react-router'

const links = [
	['/providers', 'Providers'],
	['/companies', 'Companies'],
	['/icp', 'ICP'],
	['/scores', 'Scores'],
	['/campaigns', 'Campaigns'],
] as const

export function AppHeader() {
	const { data: user } = useSession()
	const { data: users = [] } = useUsers()
	const pickUser = usePickUser()

	return (
		<header className="border-b">
			<div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
				<NavLink to="/" className="font-semibold">
					Lumina Outbound
				</NavLink>
				<nav aria-label="Main" className="flex flex-wrap gap-4 text-sm">
					{links.map(([to, label]) => (
						<NavLink
							key={to}
							to={to}
							className={({ isActive }) => (isActive ? 'font-medium' : 'text-muted-foreground hover:text-foreground')}
						>
							{label}
						</NavLink>
					))}
				</nav>
				<div className="ml-auto flex items-center gap-2">
					<span id="acting-as" className="text-sm text-muted-foreground">
						Acting as
					</span>
					<Select value={user?.id ?? ''} onValueChange={(userId) => pickUser.mutate(userId)}>
						<SelectTrigger aria-labelledby="acting-as" className="w-64">
							<SelectValue placeholder="Choose a user" />
						</SelectTrigger>
						<SelectContent>
							{users.map((option) => (
								<SelectItem key={option.id} value={option.id}>
									{option.name} ({roleLabels[option.role]})
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{user && <Badge variant={user.role === 'lead' ? 'default' : 'secondary'}>{roleLabels[user.role]}</Badge>}
				</div>
			</div>
		</header>
	)
}
