import { expect, test, type Page } from '@playwright/test'

// Same as choosing a user in the header picker, without the clicks.
export async function pickUser(page: Page, userId: string) {
	const origin = test.info().project.use.baseURL!
	const response = await page.request.put('/api/session', { data: { userId }, headers: { Origin: origin } })
	expect(response.ok()).toBe(true)
}

// A new campaign's personal lines are written in the background; the page says so until the last one is there.
export async function waitForLines(page: Page) {
	await expect(page.getByText(/^Writing personal lines:/)).toBeHidden()
}
