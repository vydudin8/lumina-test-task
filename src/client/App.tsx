import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router'
import { AppHeader } from './components/AppHeader.tsx'
import { HomePage } from './pages/HomePage.tsx'

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

const router = createBrowserRouter([{ element: <Layout />, children: [{ index: true, element: <HomePage /> }] }])

export function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	)
}
