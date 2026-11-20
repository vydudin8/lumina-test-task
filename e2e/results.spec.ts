import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

import { pickUser } from './helpers.ts'

const manifest = JSON.parse(readFileSync(new URL('../fixtures/manifest.json', import.meta.url), 'utf8')) as {
	historical: {
		byVariant: Record<'A' | 'B', { replies: number; visits: number; meetings: number }>
		outsideWindow: number
	}
}

test('the historical campaign shows A/B results with late events left out', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/campaigns')
	await page.getByRole('link', { name: 'Spring contractors push' }).click()

	const results = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Results' }) })
	const row = (label: string) =>
		results.getByRole('row').filter({ has: page.getByRole('cell', { name: label, exact: true }) })
	const { A, B } = manifest.historical.byVariant
	await expect(row('Replies')).toContainText(`${A.replies}`)
	await expect(row('Website visits').getByRole('cell').nth(1)).toContainText(`${A.visits}`)
	await expect(row('Website visits').getByRole('cell').nth(2)).toContainText(`${B.visits}`)
	await expect(
		results.getByText(`${manifest.historical.outsideWindow} events after the 30-day window (not counted)`),
	).toBeVisible()
	await expect(results.getByText(/Sample too small to conclude/)).toBeVisible()

	await row('Website visits').getByRole('button').first().click()
	await expect(results.getByText(/day \d+ after mailing/).first()).toBeVisible()
})
