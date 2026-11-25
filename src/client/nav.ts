export const NAV_LINKS = [
	['/providers', 'Providers'],
	['/companies', 'Companies'],
	['/icp', 'ICP'],
	['/scores', 'Scores'],
	['/campaigns', 'Campaigns'],
	['/suppressions', 'Suppression'],
	['/audit', 'Audit log'],
] as const

// Header links navigate with this state: a fresh start, so lists open on page one and no back link shows.
export const FRESH = { fresh: true }
export const isFresh = (state: unknown) => (state as { fresh?: unknown } | null)?.fresh === true

// The header section a path belongs to, e.g. "/companies/12" -> ['/companies', 'Companies'].
export const sectionOf = (pathname: string) =>
	NAV_LINKS.find(([path]) => pathname.startsWith(`${path}/`) || pathname === path)
