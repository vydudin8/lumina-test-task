import { expect, test } from '@playwright/test'
import { pickUser, waitForLines } from './helpers.ts'

test('after a lead sends, the provider webhook status shows on the card within 5 seconds', async ({ page }) => {
	await pickUser(page, 'usr_lead_maya')
	await page.goto('/campaigns')
	await page.getByLabel('Name').fill('E2E send')
	await page.getByLabel('Top companies').fill('5')
	await page.getByRole('button', { name: 'Build campaign' }).click()
	await expect(page.getByRole('heading', { name: 'E2E send' })).toBeVisible()
	await waitForLines(page)

	await page.getByRole('button', { name: /^Select the \d+ to review$/ }).click()
	await page.getByRole('button', { name: /^Approve \d+$/ }).click()
	const sendButton = page.getByRole('button', { name: /^Send \d+ approved$/ })
	await expect(sendButton).toBeEnabled()
	await sendButton.click()
	await page
		.getByRole('dialog')
		.getByRole('button', { name: /^Send \d+$/ })
		.click()

	const started = Date.now()
	await expect(
		page
			.getByText(/^(Delivered|Returned)$/)
			.filter({ visible: true })
			.first(),
	).toBeVisible({
		timeout: 5000,
	})
	expect(Date.now() - started).toBeLessThan(5000)
	await page.getByRole('button', { name: 'Expand all' }).click()
	await expect(page.getByText(/^Sent to the printer/).first()).toBeVisible()
	// With every card open, the one bulk toggle turns into Collapse all.
	await expect(page.getByRole('button', { name: 'Expand all' })).toBeHidden()
	await page.getByRole('button', { name: 'Collapse all' }).click()
	await expect(page.getByText(/^Sent to the printer/)).toHaveCount(0)
})
