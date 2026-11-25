import { expect, test } from '@playwright/test'
import { pickUser } from './helpers.ts'

test('editing the ICP updates the counts live and saving creates a new version', async ({ page }) => {
	await pickUser(page, 'usr_lead_maya')
	await page.goto('/icp')
	await expect(page.getByText(/Version 1, saved by Maya Fernandes/)).toBeVisible()
	const counts = page.getByText(/companies in the profile/)
	await expect(counts).toBeVisible()
	const before = await counts.textContent()

	await page.getByRole('checkbox', { name: 'headcount is required' }).click()
	await expect(page.getByText('(not saved yet)')).toBeVisible()
	await expect(counts).not.toHaveText(before!)

	await page.getByRole('button', { name: 'Save as a new version' }).click()
	await expect(page.getByText(/Version 2, saved by Maya Fernandes/)).toBeVisible()

	// Opening another version with unsaved edits asks first.
	await page.getByRole('checkbox', { name: 'headcount is required' }).click()
	const openVersion1 = page.getByRole('link', { name: 'Load into editor' }).last()
	const dialog = page.getByRole('dialog', { name: 'Discard unsaved changes?' })
	await openVersion1.click()
	await dialog.getByRole('button', { name: 'Keep editing' }).click()
	await expect(page.getByText('(not saved yet)')).toBeVisible()
	await expect(page.getByText(/Version 2, saved by/)).toBeVisible()
	await openVersion1.click()
	await dialog.getByRole('button', { name: 'Discard and switch' }).click()
	await expect(page.getByText(/Version 1, saved by .* This is an older version/)).toBeVisible()
})

test('a score breaks down by rule and gets an explanation that cites its evidence', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/scores?version=1')
	const first = page.getByRole('row').nth(1)
	await expect(first.getByRole('cell').first()).toHaveText('1')
	await expect(first.getByRole('cell').nth(2)).toHaveText('100')
	await first.getByRole('button').click()

	const panel = page.getByRole('dialog')
	await expect(panel.getByText('100 of 100 points')).toBeVisible()
	// Written on its own when the panel opens; each cited item is marked in the text and opens in the evidence list.
	await expect(panel.getByText(/AI · fact-checked|Template/)).toBeVisible()
	await panel.getByRole('button', { name: 'Evidence e1' }).first().click()
	await expect(panel.locator('#evidence-e1')).toBeVisible()
	await expect(panel.locator('#evidence-e1')).toHaveText(/^e1: company = /)
})

test('countries are picked by name with the best match first, and a range can leave one side open', async ({
	page,
}) => {
	await pickUser(page, 'usr_lead_maya')
	await page.goto('/icp')

	const countries = page.getByRole('combobox', { name: 'Countries' })
	await countries.fill('ger')
	await expect(page.getByRole('option').first()).toHaveText(/^Germany/)
	await countries.press('Enter')
	await expect(page.getByRole('button', { name: 'Remove Germany' })).toBeVisible()
	await expect(page.getByText('(not saved yet)')).toBeVisible()

	await expect(page.getByText('Passes when revenue is at least £10,000,000.')).toBeVisible()
	await page.getByLabel('Maximum revenue').fill('5')
	await expect(page.getByText('The minimum is above the maximum')).toBeVisible()
	await page.getByLabel('Minimum revenue').fill('')
	await expect(page.getByText('Passes when revenue is at most £5.')).toBeVisible()

	// Number fields keep digits only and stay within their limit.
	const points = page.getByLabel('Points for country')
	await points.fill('-5')
	await expect(points).toHaveValue('5')
	await points.fill('150')
	await expect(points).toHaveValue('100')
	await page.getByLabel('Minimum headcount').fill('-1e3')
	await expect(page.getByLabel('Minimum headcount')).toHaveValue('13')
})

test('scores split into in and out of the profile, each searchable and paged', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/scores?version=1')
	await expect(page.getByRole('tab', { name: /^In the profile/ })).toHaveAttribute('aria-selected', 'true')
	await expect(page.getByText(/^1–20 of \d+$/)).toBeVisible()
	await page.getByRole('button', { name: 'Next' }).click()
	await expect(page.getByText(/^21–\d+ of \d+$/)).toBeVisible()

	await page.getByRole('tab', { name: /^Out of the profile/ }).click()
	await expect(page).toHaveURL(/tab=out/)
	await expect(page.getByRole('columnheader', { name: 'Why it is out' })).toBeVisible()
	await page.getByRole('searchbox', { name: 'Search companies' }).fill('zzzz')
	await expect(page.getByText('No company matches “zzzz”.')).toBeVisible()
})

test('the back link returns to the list as it was left, and a header tab starts it over', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/scores?version=1')
	await page.getByRole('button', { name: 'Next' }).click()
	const secondPage = page.getByText(/^21–40 of \d+$/)
	await expect(secondPage).toBeVisible()
	await page.getByRole('row').nth(1).getByRole('button').click()
	await page.getByRole('dialog').getByRole('link').first().click()
	await expect(page).toHaveURL(/\/companies\/\d+$/)

	await page.getByRole('link', { name: 'Back to Scores' }).click()
	await expect(secondPage).toBeVisible()
	await expect(page.getByRole('dialog')).toBeVisible()
	await page.keyboard.press('Escape')

	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Scores' }).click()
	await expect(page.getByText(/^1–20 of \d+$/)).toBeVisible()
	await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0)
})
