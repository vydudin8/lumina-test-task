import { expect, test } from '@playwright/test'

test('a first visit signs in as the sales lead; a switch shows the role and survives a reload', async ({ page }) => {
	await page.goto('/')
	const header = page.getByRole('banner')
	await expect(header.getByRole('button', { name: 'Acting as Maya Fernandes (Sales lead)' })).toBeVisible()
	await expect(page.getByText('Signed in as Maya Fernandes.')).toBeVisible()

	await header.getByRole('button', { name: /^Acting as / }).click()
	await page.getByRole('menuitemradio', { name: /Tom Okafor/ }).click()
	await expect(header.getByRole('button', { name: 'Acting as Tom Okafor (Sales rep)' })).toBeVisible()
	await expect(header.getByText('Sales rep', { exact: true })).toBeVisible()

	// The cookie keeps the choice; the first-visit sign-in does not undo it.
	await page.reload()
	await expect(header.getByRole('button', { name: 'Acting as Tom Okafor (Sales rep)' })).toBeVisible()
})
