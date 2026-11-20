import { expect, test } from '@playwright/test'
import { pickUser } from './helpers.ts'

test('the audit log filters by action and shows who did it and why', async ({ page }) => {
	await pickUser(page, 'usr_lead_maya')
	await page.goto('/audit')
	await page.getByRole('combobox', { name: 'Action' }).click()
	await page.getByRole('option', { name: 'suppression.added' }).click()
	await expect(page).toHaveURL(/action=suppression.added/)
	await expect(page.getByText('7 entries')).toBeVisible()
	await expect(page.getByRole('row').nth(1)).toContainText('system:seed')
	await expect(page.getByRole('row').nth(1)).toContainText('opt_out')
})

test('a score traces to the company field and on to the raw provider JSON', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/scores?version=1')
	await page.getByRole('row').nth(1).getByRole('button').click()
	const panel = page.getByRole('region', { name: 'Score explanation' })
	await panel.getByRole('row').filter({ hasText: 'Headcount' }).getByRole('link').click()

	await expect(page).toHaveURL(/\/companies\/\d+#field-headcount$/)
	const field = page.locator('#field-headcount')
	await expect(field).toBeVisible()
	await field.getByRole('link', { name: /record$/ }).click()
	await expect(page.getByRole('dialog').getByText('Exactly what the provider sent.')).toBeVisible()
})
