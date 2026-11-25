import { usePickUser, useSession } from '#client/domain/session.ts'
import { useLiveUpdates } from '#client/lib/live.ts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router'
import { AppHeader } from './components/AppHeader.tsx'
import { BackLink } from './components/BackLink.tsx'
import { ErrorNotice, Loading, NotFound, RouteError } from './components/QueryState.tsx'
import { RawRecordSheet } from './components/RawRecords.tsx'
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
					<SignInAsLead />
				)}
			</main>
			{user && <RawRecordSheet />}
			<Toaster />
		</>
	)
}

// No passwords in this demo: a first visit signs in as the sales lead, who may do everything; the header switches user.
const FIRST_USER = 'usr_lead_maya'

function SignInAsLead() {
	const { mutate, isError, error } = usePickUser()
	useEffect(() => mutate(FIRST_USER), [mutate])
	return isError ? (
		<ErrorNotice title="Could not sign in" detail={error.message} onRetry={() => mutate(FIRST_USER)} />
	) : (
		<Loading />
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
