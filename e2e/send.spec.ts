import { expect, test } from '@playwright/test'
import { pickUser } from './helpers.ts'

test('after a lead sends, the provider webhook status shows on the card within 5 seconds', async ({ page }) => {
	await pickUser(page, 'usr_lead_maya')
	await page.goto('/campaigns')
	await page.getByLabel('Name').fill('E2E send')
	await page.getByLabel('Top companies').fill('5')
	await page.getByRole('button', { name: 'Build campaign' }).click()
	await expect(page.getByRole('heading', { name: 'E2E send' })).toBeVisible()

	await page.getByRole('button', { name: /^Approve all eligible drafts/ }).click()
	const sendButton = page.getByRole('button', { name: /^Send \d+ approved$/ })
	await expect(sendButton).toBeEnabled()
	await sendButton.click()
	await page
		.getByRole('dialog')
		.getByRole('button', { name: /^Send \d+$/ })
		.click()

	const started = Date.now()
	await expect(page.getByText(/^(Delivered|Returned)$/).first()).toBeVisible({ timeout: 5000 })
	expect(Date.now() - started).toBeLessThan(5000)
	await expect(page.getByText(/^Mail id/).first()).toBeVisible()
})
