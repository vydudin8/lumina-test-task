import { expect, test } from '@playwright/test'
import { pickUser } from './helpers.ts'

test('the audit log filters by action and shows who did it and why', async ({ page }) => {
	await pickUser(page, 'usr_lead_maya')
	await page.goto('/audit')
	await page.getByRole('combobox', { name: 'Action' }).click()
	await page.getByRole('option', { name: 'Suppression added' }).click()
	await expect(page).toHaveURL(/action=suppression.added/)
	await expect(page.getByText('7 entries')).toBeVisible()
	await expect(page.getByRole('row').nth(1)).toContainText('system:seed')
	await expect(page.getByRole('row').nth(1)).toContainText('opt_out')

	// The summary opens the whole entry beside the log; Back closes it and keeps the filter.
	await page
		.getByRole('row')
		.nth(1)
		.getByRole('button', { name: /^source:/ })
		.click()
	const sheet = page.getByRole('dialog')
	await expect(sheet.getByRole('heading', { name: 'Suppression added' })).toBeVisible()
	await expect(sheet.getByText('suppression.added', { exact: true })).toBeVisible()
	await expect(sheet.getByText(/gets no postcards/)).toBeVisible()
	await expect(sheet.getByRole('heading', { name: 'Raw JSON' })).toBeVisible()
	await page.goBack()
	await expect(sheet).toBeHidden()
	await expect(page).toHaveURL(/action=suppression.added$/)
})

test('the audit log narrows to a date range picked in the calendar filter', async ({ page }) => {
	await pickUser(page, 'usr_lead_maya')
	await page.goto('/audit')
	await page.getByRole('button', { name: 'When: Any date' }).click()
	await page.getByRole('button', { name: 'Today' }).click()
	await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/)
	await expect(page.getByRole('row').nth(1)).toContainText('system:seed')

	await page.goto('/audit?from=2000-01-01&to=2000-01-31')
	await expect(page.getByText('0 entries')).toBeVisible()
	await expect(page.getByRole('button', { name: /^When: 1\s*–\s*31 Jan 2000$/ })).toBeVisible()
})

test('a score traces to the company field and on to the raw provider JSON', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/scores?version=1')
	await page.getByRole('row').nth(1).getByRole('button').click()
	const panel = page.getByRole('dialog')
	await panel.getByRole('row').filter({ hasText: 'Headcount' }).getByRole('link').click()

	await expect(page).toHaveURL(/\/companies\/\d+#field-headcount$/)
	const field = page.locator('#field-headcount')
	await expect(field).toBeVisible()
	await field.getByRole('link', { name: /^(Apollo|FactSet|Clay)$/ }).click()
	await expect(page.getByRole('dialog').getByText('Exactly what the provider sent.')).toBeVisible()
	// The raw record opens beside the company, not on another page.
	await expect(page).toHaveURL(/\/companies\/\d+\?record=\d+$/)
})
