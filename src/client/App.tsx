import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router'
import { AppHeader } from './components/AppHeader.tsx'
import { CampaignPage } from './pages/CampaignPage.tsx'
import { CampaignsPage } from './pages/CampaignsPage.tsx'
import { CompaniesPage } from './pages/CompaniesPage.tsx'
import { CompanyPage } from './pages/CompanyPage.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { IcpPage } from './pages/IcpPage.tsx'
import { ProvidersPage } from './pages/ProvidersPage.tsx'
import { ScoresPage } from './pages/ScoresPage.tsx'
import { SuppressionsPage } from './pages/SuppressionsPage.tsx'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })

function Layout() {
	return (
		<>
			<AppHeader />
			<main className="mx-auto max-w-7xl px-4 py-6">
				<Outlet />
			</main>
		</>
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
