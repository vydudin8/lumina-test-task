import { expect, test } from '@playwright/test'

test('picking a user shows the role and survives a reload', async ({ page }) => {
	await page.goto('/')
	await expect(page.getByText('Choose who you are in the header.')).toBeVisible()

	await page.getByRole('combobox', { name: 'Acting as' }).click()
	await page.getByRole('option', { name: 'Maya Fernandes (Sales lead)' }).click()

	const header = page.getByRole('banner')
	await expect(header.getByText('Sales lead', { exact: true })).toBeVisible()
	await expect(page.getByText('Signed in as Maya Fernandes.')).toBeVisible()

	await page.reload()
	await expect(header.getByText('Sales lead', { exact: true })).toBeVisible()
})
