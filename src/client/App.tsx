import { roleLabels, usePickUser, useSession, useUsers } from '#client/domain/session.ts'
import { useLiveUpdates } from '#client/lib/live.ts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router'
import { AppHeader } from './components/AppHeader.tsx'
import { BackLink } from './components/BackLink.tsx'
import { ErrorNotice, Loading, NotFound, QueryState, RouteError } from './components/QueryState.tsx'
import { RawRecordSheet } from './components/RawRecords.tsx'
import { Button } from './components/ui/button.tsx'
import { Toaster } from './components/ui/toast.tsx'
import { AuditPage } from './pages/AuditPage.tsx'
import { CampaignPage } from './pages/CampaignPage.tsx'
import { CampaignsPage } from './pages/CampaignsPage.tsx'
import { CompaniesPage } from './pages/CompaniesPage.tsx'
import { CompanyPage } from './pages/CompanyPage.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { IcpPage } from './pages/IcpPage.tsx'
import { ProvidersPage } from './pages/ProvidersPage.tsx'
import { RunPage } from './pages/RunPage.tsx'
import { ScoresPage } from './pages/ScoresPage.tsx'
import { SuppressionsPage } from './pages/SuppressionsPage.tsx'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })

function Layout() {
	const session = useSession()
	const user = session.data
	useLiveUpdates(Boolean(user))
	return (
		<>
			<AppHeader />
			<main className="mx-auto max-w-7xl px-4 py-8">
				{session.isPending ? (
					<Loading />
				) : session.isError ? (
					<ErrorNotice
						title="Could not reach the server"
						detail={session.error.message}
						onRetry={() => void session.refetch()}
					/>
				) : user ? (
					<>
						<BackLink />
						<Outlet />
					</>
				) : (
					<ChooseUser />
				)}
			</main>
			{user && <RawRecordSheet />}
			<Toaster />
		</>
	)
}

// No passwords in this demo: everything starts with saying who you are, which decides what you may do.
function ChooseUser() {
	const users = useUsers()
	const pickUser = usePickUser()
	return (
		<div className="max-w-xl space-y-3">
			<h1 className="text-2xl font-semibold tracking-tight">Who are you?</h1>
			<p className="text-muted-foreground">
				Choose who you are in the header. Only a sales lead can approve cards and launch a send.
			</p>
			<QueryState query={users}>
				{(list) => (
					<div className="flex flex-wrap gap-2">
						{list.map((option) => (
							<Button key={option.id} variant="outline" onClick={() => pickUser.mutate(option.id)}>
								{option.name} ({roleLabels[option.role]})
							</Button>
						))}
					</div>
				)}
			</QueryState>
		</div>
	)
}

const router = createBrowserRouter([
	{
		element: <Layout />,
		// The layout itself failed (header included): the error takes the whole screen.
		errorElement: (
			<main className="mx-auto max-w-7xl px-4 py-8">
				<RouteError />
			</main>
		),
		children: [
			{
				// A page that fails keeps the header, so the rest of the app stays one click away.
				errorElement: <RouteError />,
				children: [
					{ index: true, element: <HomePage /> },
					{ path: 'providers', element: <ProvidersPage /> },
					{ path: 'providers/runs/:id', element: <RunPage /> },
					{ path: 'companies', element: <CompaniesPage /> },
					{ path: 'companies/:id', element: <CompanyPage /> },
					{ path: 'icp', element: <IcpPage /> },
					{ path: 'scores', element: <ScoresPage /> },
					{ path: 'campaigns', element: <CampaignsPage /> },
					{ path: 'campaigns/:id', element: <CampaignPage /> },
					{ path: 'suppressions', element: <SuppressionsPage /> },
					{ path: 'audit', element: <AuditPage /> },
					{ path: '*', element: <NotFound /> },
				],
			},
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
