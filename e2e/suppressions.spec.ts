import { expect, test } from '@playwright/test'
import { pickUser } from './helpers.ts'

test('the opt-out method suggests existing values, best match first, and takes a new one', async ({ page }) => {
	await pickUser(page, 'usr_lead_maya')
	await page.goto('/suppressions')
	await expect(page.getByRole('columnheader', { name: 'Opt-out method' })).toBeVisible()

	const method = page.getByRole('combobox', { name: 'Opt-out method' })
	await method.fill('e')
	await expect(page.getByRole('option')).toHaveText(['email reply', 'phone call', 'unsubscribe link', 'Add “e”'])

	await method.fill('  Letter to the office ')
	await method.press('Enter')
	await expect(method).toHaveValue('Letter to the office')
	await expect(page.getByRole('listbox')).toBeHidden()

	await method.fill('PHONE CALL')
	await method.press('Enter')
	await expect(method).toHaveValue('phone call')
})

test('the email field takes only known contacts: up to five that start with what is typed, never a new one', async ({
	page,
}) => {
	await pickUser(page, 'usr_lead_maya')
	await page.goto('/suppressions')
	const email = page.getByRole('combobox', { name: 'Email address' })
	const submit = page.getByRole('button', { name: 'Add opt-out' })

	await email.fill('a')
	const options = page.getByRole('option')
	await expect(options).toHaveCount(5)
	for (const text of await options.allTextContents()) expect(text.startsWith('a')).toBe(true)
	await expect(submit).toBeDisabled()

	const first = (await options.first().textContent())!
	await options.first().click()
	await expect(email).toHaveValue(first)
	// Not submitted: every spec shares one seeded database, and the audit spec counts opt-outs.
	await expect(submit).toBeEnabled()

	await email.fill('someone.new@example.org')
	await expect(page.getByText('No contact has an email that starts like this.')).toBeVisible()
	await expect(page.getByRole('listbox')).toBeHidden()
	await email.press('Enter')
	await expect(email).toHaveValue('someone.new@example.org')
	await expect(submit).toBeDisabled()
	await expect(page.getByText('Already on the list')).toBeHidden()
})

test('people on a short list open beside it with what each provider sent; search waits for a second page', async ({
	page,
}) => {
	await pickUser(page, 'usr_lead_maya')
	await page.goto('/suppressions')
	const optOuts = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Opt-outs/ }) })
	await expect(page.getByRole('heading', { name: 'Opt-outs (7)' })).toBeVisible()
	await expect(optOuts.getByRole('row')).toHaveCount(8)
	// Seven rows fit one page: no search box, no pager.
	await expect(page.getByRole('searchbox')).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0)

	const first = optOuts.getByRole('row').nth(1)
	const email = (await first.getByRole('cell').nth(1).textContent())!
	await first.getByRole('button').click()
	await expect(page).toHaveURL(/person=[0-9a-f]{64}/)
	const sheet = page.getByRole('dialog')
	await expect(sheet.getByText(email, { exact: true })).toBeVisible()
	await expect(sheet.getByRole('heading', { name: 'Opted out' })).toBeVisible()
	await expect(sheet.getByRole('heading', { name: /record/ }).first()).toBeVisible()
	await expect(sheet.locator('pre').first()).toContainText('"email"')
})
