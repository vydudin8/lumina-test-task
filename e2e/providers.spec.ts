import { expect, test } from '@playwright/test'
import { pickUser } from './helpers.ts'

test('provider panels trace counts to raw records and rejected rows', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/providers')

	const apollo = page.locator('[data-slot="card"]').filter({ hasText: 'Apollo' })
	await expect(apollo.getByRole('button', { name: '130 companies' })).toBeVisible()
	await expect(apollo.getByText('432 last pull')).toBeVisible()

	await apollo.getByRole('button', { name: '130 companies' }).click()
	await expect(page.getByText('1–20 of 130')).toBeVisible()
	const records = page.locator('#raw-records')
	await records.getByRole('button', { name: 'Next' }).click()
	await expect(page.getByText('21–40 of 130')).toBeVisible()
	await records.getByRole('button', { name: 'Previous' }).click()
	await records.getByRole('row').nth(1).click()
	const drawer = page.getByRole('dialog')
	await expect(drawer.getByText('Exactly what the provider sent.')).toBeVisible()
	await expect(drawer.locator('pre')).toContainText('"primary_domain"')
	await page.keyboard.press('Escape')
	await expect(drawer).toBeHidden()

	// Search applies by itself after typing stops; × clears it.
	await records.getByLabel('Search records').fill('primary_domain-that-matches-nothing')
	await expect(records.getByText('No records match these filters.')).toBeVisible()
	await records.getByRole('button', { name: 'Clear search' }).click()
	await expect(page.getByText('1–20 of 130')).toBeVisible()
})

test('a run opens with every record it received, filterable down to the rejected ones', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/providers')

	const apollo = page.locator('[data-slot="card"]').filter({ hasText: 'Apollo' })
	await apollo.getByRole('link', { name: '1 in the last pull' }).click()
	await expect(page.getByRole('heading', { name: /Apollo pull #\d+/ })).toBeVisible()
	await page.getByRole('row').filter({ hasText: 'missing name' }).click()
	await expect(page.getByRole('dialog').getByText('This record was not stored.')).toBeVisible()
	await page.keyboard.press('Escape')
	await expect(page.getByRole('dialog')).toBeHidden()

	await page.getByRole('button', { name: /^All stored/ }).click()
	await expect(page.getByText('1–20 of 431')).toBeVisible()
	await page.getByRole('combobox', { name: 'Record type' }).click()
	await page.getByRole('option', { name: 'Companies' }).click()
	await expect(page.getByText('130 records')).toBeVisible()
})

test('a pull runs in the background and the panel follows it to the end', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/providers')

	const clay = page.locator('[data-slot="card"]').filter({ hasText: 'Clay' })
	await expect(clay.getByText('(1 run)')).toBeVisible()
	await clay.getByRole('button', { name: 'Pull now' }).click()
	// The toast that said it started turns into the result; a pull this fast may skip the first one entirely.
	await expect(page.getByText('Clay pull finished', { exact: true })).toBeVisible()
	await expect(page.getByText(/^\d+ new, \d+ unchanged, 1 rejected\.$/)).toBeVisible()
	// Pushed by the server, not polled: the new run shows, and the button comes back once it has ended.
	await expect(clay.getByText('(2 runs)')).toBeVisible()
	await expect(clay.getByRole('button', { name: 'Pull now' })).toBeEnabled()
	await expect(clay.getByText(/^OK/)).toBeVisible()
})
