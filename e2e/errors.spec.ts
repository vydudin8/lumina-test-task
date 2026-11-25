import { expect, test } from '@playwright/test'
import { pickUser } from './helpers.ts'

test('a page that crashes keeps the header and offers a reload', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	// A reply the page cannot render: it throws while rendering, and the route's error boundary takes over.
	await page.route('**/api/ingestion-runs/*', (route) => route.fulfill({ json: { run: {} } }))
	await page.goto('/providers/runs/1')
	await expect(page.getByRole('heading', { name: 'This page stopped working' })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Reload page' })).toBeVisible()
	await expect(page.getByRole('link', { name: 'Companies' })).toBeVisible()
})

test('a request that fails says so and can be tried again', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	let fail = true
	await page.route('**/api/ingestion-runs/*', (route) =>
		fail ? route.fulfill({ status: 500, json: { error: 'Internal server error' } }) : route.fallback(),
	)
	await page.goto('/providers/runs/1')
	await expect(page.getByRole('alert')).toContainText('Internal server error')
	fail = false
	await page.getByRole('button', { name: 'Try again' }).click()
	await expect(page.getByRole('heading', { name: /pull #1$/ })).toBeVisible()
})

test('an unknown address shows page not found inside the app', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/no-such-page')
	await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
	await expect(page.getByRole('link', { name: 'Companies' })).toBeVisible()
})
