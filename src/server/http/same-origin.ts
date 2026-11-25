import { createMiddleware } from 'hono/factory'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// CSRF guard: browsers send Origin on every non-GET request, so anything else is cross-site or not a browser.
export const sameOriginOnly = createMiddleware(async (context, next) => {
	// Host only, either scheme: behind a TLS-terminating proxy the app sees http:// while the browser says https://.
	const { host } = new URL(context.req.url)
	const origin = context.req.header('origin')
	if (!SAFE_METHODS.has(context.req.method) && origin !== `http://${host}` && origin !== `https://${host}`) {
		return context.json({ error: 'Cross-site request blocked.' }, 403)
	}
	await next()
})
