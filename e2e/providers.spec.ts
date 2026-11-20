import { expect, test } from '@playwright/test'
import { pickUser } from './helpers.ts'

test('provider panels trace counts to raw records and rejected rows', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/providers')

	const apollo = page.locator('[data-slot="card"]').filter({ hasText: 'Apollo' })
	await expect(apollo.getByRole('button', { name: '130 companies' })).toBeVisible()
	await expect(apollo.getByText('432 last pull')).toBeVisible()

	await apollo.getByRole('button', { name: '1 in the last pull' }).click()
	await expect(page.getByRole('dialog').getByText('missing name')).toBeVisible()
	await page.keyboard.press('Escape')

	await apollo.getByRole('button', { name: '130 companies' }).click()
	await expect(page.getByText('1–50 of 130')).toBeVisible()
	await page.locator('#raw-records').getByRole('row').nth(1).click()
	const drawer = page.getByRole('dialog')
	await expect(drawer.getByText('Exactly what the provider sent.')).toBeVisible()
	await expect(drawer.locator('pre')).toContainText('"primary_domain"')
})
