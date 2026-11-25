import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

import { pickUser } from './helpers.ts'

const manifest = JSON.parse(readFileSync(new URL('../fixtures/manifest.json', import.meta.url), 'utf8')) as {
	historical: {
		byVariant: Record<'A' | 'B', { sent: number; replies: number; visits: number; meetings: number }>
		outsideWindow: number
	}
}

test('the historical campaign shows A/B results with late events left out', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/campaigns')
	await page.getByRole('link', { name: 'Spring contractors push' }).click()

	const results = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Results' }) })
	// Header row first, then one row per template; data cells run Sent, Delivered, Replies, Visits, Meetings.
	const cell = (template: 1 | 2, column: number) => results.getByRole('row').nth(template).getByRole('cell').nth(column)
	const { A, B } = manifest.historical.byVariant
	await expect(cell(1, 2)).toContainText(`(${A.replies})`)
	await expect(cell(1, 3)).toContainText(`(${A.visits})`)
	await expect(cell(2, 3)).toContainText(`(${B.visits})`)
	await expect(
		results.getByText(`${manifest.historical.outsideWindow} events after the 30-day window (not counted)`),
	).toBeVisible()
	await expect(results.getByText(/Sample too small to conclude/)).toBeVisible()

	await cell(1, 3).getByRole('button').click()
	await expect(
		page
			.getByRole('dialog')
			.getByText(/day \d+ after mailing/)
			.first(),
	).toBeVisible()
})

test('a company in the results opens its card; Sent filters the list; hiding results is remembered', async ({
	page,
}) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/campaigns')
	await page.getByRole('link', { name: 'Spring contractors push' }).click()

	const results = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Results' }) })
	const cell = (template: 1 | 2, column: number) => results.getByRole('row').nth(template).getByRole('cell').nth(column)

	await cell(1, 3).getByRole('button').click()
	const company = page.getByRole('dialog').getByRole('link').first()
	const name = (await company.textContent())!
	await company.click()
	await expect(page.getByRole('dialog')).toBeHidden()
	await expect(page).toHaveURL(/#card-\d+$/)
	await expect(page.getByRole('article', { name: `Card for ${name}` }).first()).toBeInViewport()

	await cell(1, 0).getByRole('button').click()
	await expect(page).toHaveURL(/show=sent/)
	await expect(page).toHaveURL(/template=A/)
	await expect(page.getByText(`${manifest.historical.byVariant.A.sent} cards`, { exact: true })).toBeVisible()

	await page.getByRole('button', { name: 'Hide results' }).click()
	await expect(results).toBeHidden()
	await page.reload()
	await expect(page.getByRole('button', { name: 'Show results' })).toBeVisible()
	await expect(results).toBeHidden()
	await page.getByRole('button', { name: 'Show results' }).click()
	await expect(results).toBeVisible()
})
