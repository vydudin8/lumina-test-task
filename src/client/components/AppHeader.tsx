import { LuminaLogo } from '#client/components/LuminaLogo.tsx'
import { roleLabels, usePickUser, useSession, useUsers } from '#client/domain/session.ts'
import { cn } from '#client/lib/utils.ts'
import { FRESH, NAV_LINKS } from '#client/nav.ts'
import type { User } from '#common/schemas.ts'
import { Check, ChevronDown, UserRound } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { NavLink } from 'react-router'

const initials = (name: string) =>
	name
		.split(/\s+/)
		.slice(0, 2)
		.map((word) => word[0])
		.join('')
		.toUpperCase()

// Initials on a role colour: a lead is solid, a rep is tinted, so the role shows even before the name is read.
function Avatar({ user }: { user: User | null | undefined }) {
	return (
		<span
			aria-hidden
			className={cn(
				'grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold',
				!user && 'border border-dashed text-muted-foreground',
				user?.role === 'lead' && 'bg-primary text-primary-foreground',
				user?.role === 'rep' && 'bg-link/10 text-link ring-1 ring-link/25',
			)}
		>
			{user ? initials(user.name) : <UserRound className="size-4" />}
		</span>
	)
}

function NameAndRole({ user }: { user: User }) {
	return (
		<span className="min-w-0 flex-1 text-left leading-tight">
			<span className="block truncate text-sm font-medium">{user.name}</span>
			<span className="block text-xs text-muted-foreground">{roleLabels[user.role]}</span>
		</span>
	)
}

export function AppHeader() {
	const { data: user } = useSession()
	const { data: users = [] } = useUsers()
	const pickUser = usePickUser()

	return (
		<header className="z-30 border-b bg-card sm:sticky sm:top-0">
			<div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-8 gap-y-2 px-4 py-2.5">
				<NavLink
					to="/"
					state={FRESH}
					aria-label="Lumina, home"
					className="flex items-center gap-2.5 rounded-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				>
					<LuminaLogo aria-hidden className="h-[18px] w-auto" />
				</NavLink>
				<nav aria-label="Main" className="flex flex-wrap gap-1 text-sm">
					{NAV_LINKS.map(([to, label]) => (
						<NavLink
							key={to}
							to={to}
							state={FRESH}
							className={({ isActive }) =>
								cn(
									'rounded-md px-2.5 py-1.5 transition-colors',
									isActive
										? 'bg-muted font-medium text-foreground'
										: 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
								)
							}
						>
							{label}
						</NavLink>
					))}
				</nav>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger
						aria-label={user ? `Acting as ${user.name} (${roleLabels[user.role]})` : 'Choose a user'}
						className="-my-1 ml-auto flex items-center gap-2.5 rounded-full py-1 pr-2 pl-1 transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted"
					>
						<Avatar user={user} />
						{user ? <NameAndRole user={user} /> : <span className="text-sm">Choose a user</span>}
						<ChevronDown className="size-4 shrink-0 text-muted-foreground" />
					</DropdownMenu.Trigger>
					<DropdownMenu.Portal>
						<DropdownMenu.Content
							align="end"
							sideOffset={6}
							className="z-50 w-64 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
						>
							<DropdownMenu.Label className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">Act as</DropdownMenu.Label>
							<DropdownMenu.RadioGroup value={user?.id ?? ''} onValueChange={(userId) => pickUser.mutate(userId)}>
								{users.map((option) => (
									<DropdownMenu.RadioItem
										key={option.id}
										value={option.id}
										className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 outline-none select-none data-[highlighted]:bg-accent"
									>
										<Avatar user={option} />
										<NameAndRole user={option} />
										<DropdownMenu.ItemIndicator>
											<Check className="size-4" />
										</DropdownMenu.ItemIndicator>
									</DropdownMenu.RadioItem>
								))}
							</DropdownMenu.RadioGroup>
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			</div>
		</header>
	)
}
