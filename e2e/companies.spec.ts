import { expect, test } from '@playwright/test'
import { pickUser } from './helpers.ts'

test('a headcount conflict traces to its sources and can be resolved by a person with a reason', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/companies')
	await expect(page.getByText('282 companies from 300 provider records')).toBeVisible()

	await page.getByRole('button', { name: '7 headcount conflicts' }).click()
	await expect(page.getByRole('row')).toHaveCount(8)
	await page.getByRole('row').nth(1).getByRole('link').click()
	await expect(page).toHaveURL(/\/companies\/\d+$/)

	const fields = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Fields' }) })
	const headcount = fields.getByRole('row').filter({ has: page.getByRole('cell', { name: /^Headcount/ }) })
	await expect(headcount.getByText('Conflict')).toBeVisible()
	await expect(headcount.getByText(/^FactSet wins/)).toBeVisible()

	await headcount.getByRole('button', { name: 'Choose value' }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByRole('radio').nth(1).check()
	await dialog.getByLabel('Reason (saved in the audit log)').fill('Checked their annual report')
	await dialog.getByRole('button', { name: 'Use this value' }).click()

	await expect(headcount.getByText('Set by a person')).toBeVisible()
	await expect(page.getByText('Reason: Checked their annual report')).toBeVisible()

	await headcount.getByRole('link').first().click()
	await expect(page.getByRole('dialog').getByText('Exactly what the provider sent.')).toBeVisible()
})

test('address conflicts have their own filter and show each provider’s street', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/companies')
	await page.getByRole('button', { name: '2 address conflicts' }).click()
	await expect(page.getByRole('row')).toHaveCount(3)
	await page.getByRole('row').nth(1).getByRole('link').click()

	const address = page.locator('#field-address')
	await expect(address.getByText('Conflict')).toBeVisible()
	await expect(address.getByText(/2 Old Station Yard/)).toBeVisible()
})
