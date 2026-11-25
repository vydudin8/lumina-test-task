import { expect, test, type Page } from '@playwright/test'
import { pickUser, waitForLines } from './helpers.ts'

// The status filter lists every view with its count: open it, then check or pick an option.
async function statusOption(page: Page, name: RegExp) {
	await page.getByRole('combobox', { name: 'Status' }).click()
	return page.getByRole('option', { name })
}

test('a top-50 campaign drafts 39 eligible cards; only a lead can approve them', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/campaigns')
	await page.getByLabel('Name').fill('E2E top 50')
	await page.getByRole('button', { name: 'Build campaign' }).click()

	await expect(page.getByRole('heading', { name: 'E2E top 50' })).toBeVisible()
	await waitForLines(page)
	await expect(page.getByText('50 cards:')).toContainText('39 eligible')
	await expect(page.getByText('50 cards:')).toContainText('11 blocked (8 suppressed, 3 bad address)')
	await expect(page.getByText('Only a sales lead can approve cards and send.')).toBeVisible()

	// A card's score opens its rule-by-rule breakdown as saved when the campaign was built; Back closes it.
	await page
		.getByRole('article')
		.first()
		.getByRole('button', { name: /^Score \d+/ })
		.click()
	const scoreSheet = page.getByRole('dialog')
	await expect(scoreSheet.getByText(/^Rank 1 in this campaign, score \d+/)).toBeVisible()
	await expect(scoreSheet.getByRole('columnheader', { name: 'Points' })).toBeVisible()
	await page.goBack()
	await expect(scoreSheet).toBeHidden()

	// Search narrows the cards by company name; Clear filters brings them back.
	await page.getByLabel('Search cards').fill('no company is called this')
	await expect(page.getByText('No card matches “no company is called this”.')).toBeVisible()
	await page.getByRole('button', { name: 'Clear filters' }).click()

	// The seeded address conflict in the top 50 is flagged on its card and links to the sources.
	const conflicted = page.getByRole('article').filter({ hasText: 'Providers disagree on this address' })
	await expect(conflicted).toHaveCount(1)
	await expect(conflicted.getByText(/Address from Apollo/)).toBeVisible()
	await expect(conflicted.getByRole('link', { name: 'see sources' })).toHaveAttribute('href', /#field-address$/)

	await (await statusOption(page, /^Blocked \(/)).click()
	const blocked = page.getByRole('article').first()
	await expect(
		blocked.getByText(/Opted out|Mailed in the last 90 days|Address has no|Postcode is not valid/),
	).toBeVisible()
	await blocked.getByRole('button', { name: /^Expand / }).click()
	await blocked.getByText('Why this person').click()
	await expect(blocked.getByText('We do not send it to someone else instead.')).toBeVisible()

	await pickUser(page, 'usr_lead_maya')
	await page.reload()
	await (await statusOption(page, /^To review \(39\)/)).click()
	await page.getByRole('checkbox', { name: 'Select every card on this page' }).check()
	await page.getByRole('button', { name: 'Approve 39' }).click()
	// Sent or not, an approved card stays counted as approved; once decided it folds to one line.
	await expect(page.getByRole('combobox', { name: 'Status' })).toHaveText(/^To review \(0\)/)
	await (await statusOption(page, /^Approved \(39\)/)).click()
	await expect(
		page
			.getByRole('article')
			.first()
			.getByRole('button', { name: /^(Expand|Collapse) / }),
	).toHaveAttribute('aria-expanded', 'false')
})

test('cards remember being folded per visit, bulk decisions show as one history entry with each card', async ({
	page,
}) => {
	await pickUser(page, 'usr_lead_maya')
	await page.goto('/campaigns')
	await page.getByLabel('Name').fill('E2E bulk')
	await page.getByLabel('Top companies').fill('10')
	await page.getByRole('button', { name: 'Build campaign' }).click()
	await expect(page.getByRole('heading', { name: 'E2E bulk' })).toBeVisible()
	await waitForLines(page)

	// Cards to review start open; folding one survives a reload and Back, and a fresh visit starts over.
	const first = page.getByRole('article').first()
	const toggle = first.getByRole('button', { name: /^(Expand|Collapse) / })
	await expect(toggle).toHaveAttribute('aria-expanded', 'true')
	await toggle.click()
	await expect(toggle).toHaveAttribute('aria-expanded', 'false')
	await page.reload()
	await expect(toggle).toHaveAttribute('aria-expanded', 'false')
	await first.getByRole('link').first().click()
	await page.goBack()
	await expect(toggle).toHaveAttribute('aria-expanded', 'false')
	await page.getByRole('link', { name: 'Back to Campaigns' }).click()
	await page.getByRole('link', { name: 'E2E bulk' }).first().click()
	await expect(toggle).toHaveAttribute('aria-expanded', 'true')

	// Reject two with one reason, approve the rest in one go.
	const drafts = page.getByRole('article').filter({ has: page.getByText('Needs review', { exact: true }) })
	await drafts.nth(0).getByRole('checkbox').check()
	await drafts.nth(1).getByRole('checkbox').check()
	await page.getByRole('button', { name: 'Reject 2' }).click()
	await page.getByLabel('Reason (saved in the audit log)').fill('Not a fit this quarter')
	await page.getByRole('dialog').getByRole('button', { name: 'Reject 2' }).click()
	await expect(await statusOption(page, /^Rejected \(2\)/)).toBeVisible()
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: /^Select the \d+ to review$/ }).click()
	await page.getByRole('button', { name: /^Approve \d+$/ }).click()
	await expect(await statusOption(page, /^To review \(0\)/)).toBeVisible()
	await page.keyboard.press('Escape')

	// Exact: each open card has its own "History of …" button.
	await page.getByRole('button', { name: 'History', exact: true }).click()
	const history = page.getByRole('dialog')
	await expect(history.getByText('Created', { exact: true })).toBeVisible()
	await expect(history.getByText(/^\d+ cards approved$/)).toBeVisible()
	const rejected = history.getByRole('listitem').filter({ hasText: '2 cards rejected' })
	await rejected.getByRole('button', { name: 'Show 2 cards' }).click()
	await expect(rejected.getByText('Reason: Not a fit this quarter')).toHaveCount(2)
})

test('a campaign can skip the A/B test and send one template to everyone', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/campaigns')
	await page.getByLabel('Name').fill('E2E one template')
	await page.getByLabel('Top companies').fill('10')
	await page.getByLabel('A/B test', { exact: true }).uncheck()
	await expect(page.getByLabel('Template B')).toBeDisabled()
	await page.getByRole('button', { name: 'Build campaign' }).click()
	await expect(page.getByRole('heading', { name: 'E2E one template' })).toBeVisible()
	await waitForLines(page)
	await expect(page.getByText(/on every card \(no A\/B test\)/)).toBeVisible()
})

test('a link to a card on a later page opens the page that holds it', async ({ page }) => {
	await pickUser(page, 'usr_rep_tom')
	await page.goto('/campaigns')
	await page.getByLabel('Name').fill('E2E pages')
	await page.getByLabel('Top companies').fill('120')
	await page.getByRole('button', { name: 'Build campaign' }).click()
	await expect(page.getByRole('heading', { name: 'E2E pages' })).toBeVisible()
	await waitForLines(page)
	await expect(page.getByText('1–50 of 120')).toBeVisible()

	const campaignId = new URL(page.url()).pathname.split('/').pop()
	const first = (await (await page.request.get(`/api/campaigns/${campaignId}/cards`)).json()) as { nextCursor: string }
	const second = (await (
		await page.request.get(`/api/campaigns/${campaignId}/cards?cursor=${first.nextCursor}`)
	).json()) as {
		cards: { id: number; companyName: string }[]
	}
	const card = second.cards[3]!
	await page.goto(`/campaigns/${campaignId}#card-${card.id}`)
	await expect(page.getByText('51–100 of 120')).toBeVisible()
	await expect(page.getByRole('article', { name: `Card for ${card.companyName}` }).first()).toBeInViewport()
})
