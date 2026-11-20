import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router'
import { AppHeader } from './components/AppHeader.tsx'
import { Button } from './components/ui/button.tsx'
import { AuditPage } from './pages/AuditPage.tsx'
import { CampaignPage } from './pages/CampaignPage.tsx'
import { CampaignsPage } from './pages/CampaignsPage.tsx'
import { CompaniesPage } from './pages/CompaniesPage.tsx'
import { CompanyPage } from './pages/CompanyPage.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { IcpPage } from './pages/IcpPage.tsx'
import { ProvidersPage } from './pages/ProvidersPage.tsx'
import { ScoresPage } from './pages/ScoresPage.tsx'
import { SuppressionsPage } from './pages/SuppressionsPage.tsx'
import { roleLabels, usePickUser, useSession, useUsers } from './session.ts'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })

function Layout() {
	const { data: user, isPending } = useSession()
	return (
		<>
			<AppHeader />
			<main className="mx-auto max-w-7xl px-4 py-6">{isPending ? null : user ? <Outlet /> : <ChooseUser />}</main>
		</>
	)
}

// No passwords in this demo: everything starts with saying who you are, which decides what you may do.
function ChooseUser() {
	const { data: users = [] } = useUsers()
	const pickUser = usePickUser()
	return (
		<div className="max-w-xl space-y-3">
			<h1 className="text-2xl font-semibold">Who are you?</h1>
			<p className="text-muted-foreground">
				Choose who you are in the header. Only a sales lead can approve cards and launch a send.
			</p>
			<div className="flex flex-wrap gap-2">
				{users.map((option) => (
					<Button key={option.id} variant="outline" onClick={() => pickUser.mutate(option.id)}>
						{option.name} ({roleLabels[option.role]})
					</Button>
				))}
			</div>
		</div>
	)
}

const router = createBrowserRouter([
	{
		element: <Layout />,
		children: [
			{ index: true, element: <HomePage /> },
			{ path: 'providers', element: <ProvidersPage /> },
			{ path: 'companies', element: <CompaniesPage /> },
			{ path: 'companies/:id', element: <CompanyPage /> },
			{ path: 'icp', element: <IcpPage /> },
			{ path: 'scores', element: <ScoresPage /> },
			{ path: 'campaigns', element: <CampaignsPage /> },
			{ path: 'campaigns/:id', element: <CampaignPage /> },
			{ path: 'suppressions', element: <SuppressionsPage /> },
			{ path: 'audit', element: <AuditPage /> },
		],
	},
])

export function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	)
}
