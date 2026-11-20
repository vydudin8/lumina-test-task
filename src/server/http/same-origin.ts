import { createMiddleware } from 'hono/factory'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// CSRF guard: browsers send Origin on every non-GET request, so anything else is cross-site or not a browser.
export const sameOriginOnly = createMiddleware(async (context, next) => {
	if (!SAFE_METHODS.has(context.req.method) && context.req.header('origin') !== new URL(context.req.url).origin) {
		return context.json({ error: 'Cross-site request blocked.' }, 403)
	}
	await next()
})
