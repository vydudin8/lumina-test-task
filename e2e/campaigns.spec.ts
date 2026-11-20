import { expect, test } from '@playwright/test'
import { pickUser } from './helpers.ts'

test('a top-50 campaign drafts 39 eligible cards; only a lead can approve them', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/campaigns')
	await page.getByLabel('Name').fill('E2E top 50')
	await page.getByRole('button', { name: 'Build campaign' }).click()

	await expect(page.getByRole('heading', { name: 'E2E top 50' })).toBeVisible()
	await expect(page.getByText('50 cards:')).toContainText('39 eligible')
	await expect(page.getByText('50 cards:')).toContainText('11 blocked (8 suppressed, 3 bad address)')
	await expect(page.getByText('Only a sales lead can approve cards and send.')).toBeVisible()

	await page.getByRole('button', { name: /^Blocked \(/ }).click()
	const blocked = page.getByRole('article').first()
	await expect(
		blocked.getByText(/Opted out|Mailed in the last 90 days|Address has no|Postcode is not valid/),
	).toBeVisible()
	await blocked.getByText('Why this person').click()
	await expect(blocked.getByText('We do not send it to someone else instead.')).toBeVisible()

	await pickUser(page, 'usr_lead_maya')
	await page.reload()
	await page.getByRole('button', { name: 'Approve all eligible drafts (39)' }).click()
	await expect(page.getByRole('button', { name: /^Approved \(39\)/ })).toBeVisible()
})
