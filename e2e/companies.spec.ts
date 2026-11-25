import { expect, test } from '@playwright/test'
import { pickUser } from './helpers.ts'

test('a headcount conflict traces to its sources and can be resolved by a person with a reason', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/companies')
	await expect(page.getByText('282 companies from 300 provider records')).toBeVisible()

	await page.getByRole('button', { name: '7 headcount conflicts' }).click()
	await expect(page.getByRole('row')).toHaveCount(8)
	// Values show the country's full name and open the company at that field.
	await expect(page.getByRole('row').nth(1).getByRole('link', { name: 'United Kingdom' })).toHaveAttribute(
		'href',
		/#field-country$/,
	)
	// The flag opens the company at the field it is about.
	await page.getByRole('row').nth(1).getByRole('link', { name: 'Headcount conflict' }).click()
	await expect(page).toHaveURL(/\/companies\/\d+#field-headcount$/)
	// The domain opens the company's website in a new tab.
	const site = page.getByRole('link', { name: /\(opens in a new tab\)$/ }).first()
	await expect(site).toHaveAttribute('href', /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/)
	await expect(site).toHaveAttribute('target', '_blank')

	const fields = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Fields' }) })
	const headcount = fields.getByRole('row').filter({ has: page.getByRole('cell', { name: /^Headcount/ }) })
	await expect(headcount.getByText('Conflict')).toBeVisible()
	await expect(headcount.getByText(/^FactSet wins/)).toBeVisible()

	await headcount.getByRole('button', { name: 'Choose value' }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByRole('radio').nth(1).check()
	await dialog.getByLabel('Reason (saved in the audit log)').fill('Checked their annual report')
	await dialog.getByRole('button', { name: 'Use this value' }).click()

	// One badge: the conflict is struck through and marked as overridden, no longer red.
	await expect(headcount.getByText('Conflict overridden')).toBeVisible()
	await page.getByRole('button', { name: 'History' }).click()
	const history = page.getByRole('dialog', { name: 'History' })
	await expect(history.getByText('Reason: Checked their annual report')).toBeVisible()
	await expect(history.getByText(/^Headcount: .+ → .+$/)).toBeVisible()
	await page.keyboard.press('Escape')
	await expect(history).toBeHidden()

	await headcount.getByRole('link').first().click()
	await expect(page.getByRole('dialog').getByText('Exactly what the provider sent.')).toBeVisible()
})

test('address conflicts have their own filter and show each provider’s street', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	// A summary link clears the other filters, so it lists every company it counts.
	await page.goto('/companies?q=no-such-company&country=FR')
	await page.getByRole('button', { name: '2 address conflicts' }).click()
	await expect(page).toHaveURL(/\/companies\?filter=conflict%3Aaddress$/)
	await expect(page.getByRole('row')).toHaveCount(3)
	await page.getByRole('row').nth(1).getByRole('link').first().click()

	const address = page.locator('#field-address')
	await expect(address.getByText('Conflict')).toBeVisible()
	await expect(address.getByText(/2 Old Station Yard/)).toBeVisible()
})

test('companies page, sort on the server and filter by several values at once', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/companies')
	const table = page.locator('[aria-busy="false"]')
	await expect(page.getByText('1–20 of 282')).toBeVisible()
	await page.getByRole('button', { name: 'Next' }).click()
	await expect(page.getByText('21–40 of 282')).toBeVisible()

	// Sorting starts again from the first page, biggest headcount first.
	await page.getByRole('columnheader', { name: 'Headcount' }).getByRole('button').click()
	await expect(page).toHaveURL(/sort=headcount&dir=desc/)
	await expect(page.getByText('1–20 of 282')).toBeVisible()
	await expect(page.getByRole('columnheader', { name: 'Headcount' })).toHaveAttribute('aria-sort', 'descending')
	await expect
		.poll(async () => {
			const numbers = (await table.locator('tbody tr td:nth-child(4)').allTextContents()).map((text) =>
				Number(text.replace(/,/g, '')),
			)
			return numbers.length === 20 && numbers.every((n, i) => i === 0 || numbers[i - 1]! >= n)
		})
		.toBe(true)

	await page.getByRole('button', { name: 'All countries' }).click()
	await page.getByRole('menuitemcheckbox', { name: 'Ireland (IE)' }).click()
	await page.getByRole('menuitemcheckbox', { name: 'Germany (DE)' }).click()
	await page.keyboard.press('Escape')
	await expect(page.getByRole('button', { name: /^Country: .+ \+1$/ })).toBeVisible()
	await expect
		.poll(async () => new Set(await table.locator('tbody tr td:nth-child(2)').allTextContents()))
		.toEqual(new Set(['Ireland', 'Germany']))

	// The slider moves by keyboard too; each step is the next threshold.
	await page.getByRole('button', { name: 'Any headcount' }).click()
	const minimum = page.getByRole('slider', { name: 'Minimum headcount' })
	await minimum.focus()
	for (let step = 0; step < 3; step++) await minimum.press('ArrowRight')
	await expect(page).toHaveURL(/headcountMin=50/)
	await page.keyboard.press('Escape')
	await expect(page.getByRole('button', { name: 'Headcount: 50 or more' })).toBeVisible()

	await page.getByRole('button', { name: 'Clear filters' }).click()
	await expect(page.getByText('1–20 of 282')).toBeVisible()
	await expect(page).toHaveURL(/sort=headcount/)
})

test('the list keeps its page and filters when you open a company and come back', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/companies?industry=Quarrying')
	await page.getByRole('button', { name: 'Next' }).click()
	const range = page.getByText(/^21–\d+ of \d+$/)
	await expect(range).toBeVisible()

	await page.getByRole('row').nth(1).getByRole('link').first().click()
	await expect(page).toHaveURL(/\/companies\/\d+$/)
	await page.goBack()
	await expect(range).toBeVisible()

	await page.getByRole('row').nth(1).getByRole('link').first().click()
	await page.getByRole('main').getByRole('link', { name: 'Back to Companies' }).click()
	await expect(page).toHaveURL(/industry=Quarrying/)
	await expect(range).toBeVisible()

	await page.getByRole('button', { name: 'First' }).click()
	await expect(page.getByText(/^1–20 of \d+$/)).toBeVisible()

	// A header tab is a fresh start: no filters, first page.
	await page.getByRole('button', { name: 'Next' }).click()
	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Companies' }).click()
	await expect(page).toHaveURL(/\/companies$/)
	await expect(page.getByText('1–20 of 282')).toBeVisible()
})

test('a merge leads the merged-away number to the company, and can be undone from the history', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/companies?filter=duplicates')
	await page.getByRole('row').nth(1).getByRole('link').first().click()
	await expect(page).toHaveURL(/\/companies\/\d+$/)
	const first = Number(new URL(page.url()).pathname.split('/').pop())
	const duplicates = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Possible duplicates' }) })
	const other = Number((await duplicates.getByRole('link').first().getAttribute('href'))!.split('/').pop())

	await duplicates.getByRole('button', { name: 'Merge into this company' }).first().click()
	const merge = page.getByRole('dialog', { name: 'Merge companies' })
	await merge.getByLabel('Reason (saved in the audit log)').fill('Same firm, Irish branch')
	await merge.getByRole('button', { name: 'Merge' }).click()
	// Exact: Radix also announces the toast for a second in a hidden live region, as "Notification Companies merged…".
	await expect(page.getByText('Companies merged', { exact: true })).toBeVisible()
	// Whichever number the merge kept, the other one now leads to it.
	const kept = (await page.request.get(`/api/companies/${first}`, { maxRedirects: 0 })).status() === 200
	const [merged, gone] = kept ? [first, other] : [other, first]
	await page.goto(`/companies/${gone}`)
	await expect(page).toHaveURL(`/companies/${merged}`)
	await expect(page.getByText(`Company #${gone} was merged into this one.`)).toBeVisible()

	await page.getByRole('button', { name: 'History' }).click()
	const history = page.getByRole('dialog', { name: 'History' })
	await history.getByRole('button', { name: 'Undo merge' }).click()
	const undo = page.getByRole('dialog', { name: 'Undo this merge' })
	await undo.getByLabel('Reason (saved in the audit log)').fill('Separate legal entities')
	await undo.getByRole('button', { name: 'Undo merge' }).click()
	await expect(page.getByText(/^The records are back in companies #\d+ and #\d+\.$/)).toBeVisible()
	await expect(history.getByText('Reason: Separate legal entities')).toBeVisible()
	await expect(history.getByRole('button', { name: 'Undo merge' })).toBeHidden()

	await page.goto(`/companies/${gone}`)
	await expect(page).toHaveURL(`/companies/${gone}`)
	await expect(page.getByText('was merged into this one')).toBeHidden()
})
