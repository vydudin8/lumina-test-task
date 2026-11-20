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
})

test('a score breaks down by rule and gets an explanation that cites its evidence', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/scores?version=1')
	const first = page.getByRole('row').nth(1)
	await expect(first.getByRole('cell').first()).toHaveText('1')
	await expect(first.getByRole('cell').nth(2)).toHaveText('100')
	await first.getByRole('button').click()

	const panel = page.getByRole('region', { name: 'Score explanation' })
	await expect(panel.getByText('100 of 100 points')).toBeVisible()
	await panel.getByRole('button', { name: 'Write an explanation' }).click()
	await expect(panel.getByText(/^Sources:/)).toBeVisible()
	await expect(panel.getByText(/Written by AI, checked against the evidence|AI text rejected/)).toBeVisible()
})
