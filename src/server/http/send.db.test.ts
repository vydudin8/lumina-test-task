import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { suppressions } from '../db/schema.ts'
import { runIngestion } from '../pipeline/ingest/index.ts'
import { personKeyHash } from '../policy/person-key.ts'
import { seedHistory } from '../seed/history.ts'
import { seed } from '../seed/seed.ts'
import { call, createTestApp, loginAs, testDeps, type FetchApp } from '../test/app.ts'
import { useTestDb } from '../test/db.ts'

const now = new Date('2026-11-20T12:00:00Z')

describe('contact email suggestions for the opt-out form', () => {
	const t = useTestDb()
	let app: FetchApp
	let cookie: string

	beforeAll(async () => {
		await seed(t.db, { now })
		const deps = testDeps(t.db, { clock: () => now })
		for (const provider of ['apollo', 'factset', 'clay'] as const) await runIngestion(deps, provider, 'system:test')
		app = createTestApp(t.db, { clock: () => now })
		cookie = await loginAs(app, 'usr_rep_tom')
	})

	const emails = async (q: string) => {
		const response = await call(app, `/api/contacts/emails?q=${encodeURIComponent(q)}`, { cookie })
		expect(response.status).toBe(200)
		return ((await response.json()) as { emails: string[] }).emails
	}

	it('gives at most five distinct emails that start with what was typed, in order, ignoring case', async () => {
		const found = await emails('a')
		expect(found.length).toBe(5)
		expect(found.every((email) => email.startsWith('a'))).toBe(true)
		expect(new Set(found).size).toBe(found.length)
		expect([...found].sort()).toEqual(found)
		expect(await emails('  A')).toEqual(found)
	})

	it('treats LIKE wildcards as plain characters', async () => {
		expect(await emails('%')).toEqual([])
		expect(await emails('_')).toEqual([])
	})

	it('needs a signed-in user and something to search for', async () => {
		expect((await call(app, '/api/contacts/emails?q=a')).status).toBe(401)
		expect((await call(app, '/api/contacts/emails?q=', { cookie })).status).toBe(400)
	})
})

describe('people on the suppression list', () => {
	const t = useTestDb()
	let app: FetchApp
	let cookie: string

	beforeAll(async () => {
		await seed(t.db, { now })
		const deps = testDeps(t.db, { clock: () => now })
		for (const provider of ['apollo', 'factset', 'clay'] as const) await runIngestion(deps, provider, 'system:test')
		await seedHistory(t.db, now)
		app = createTestApp(t.db, { clock: () => now })
		cookie = await loginAs(app, 'usr_rep_tom')
	})

	const get = async <T>(path: string) => {
		const response = await call(app, path, { cookie })
		expect(response.status).toBe(200)
		return (await response.json()) as T
	}
	type Person = {
		records: { email: string; provider: string; companyId: number | null; payload: unknown }[]
		optOut: { source: string } | null
		cards: { campaignName: string; email: string | null; fullName: string | null }[]
	}

	it('shows the email of an opt-out while a provider lists the person, and opens their records with the raw JSON', async () => {
		const list = await get<{ optOuts: { personKeyHash: string; email: string | null }[] }>('/api/suppressions/opt-outs')
		const known = list.optOuts.find((row) => row.email)!
		expect(personKeyHash(known.email!)).toBe(known.personKeyHash)

		const person = await get<Person>(`/api/people/${known.personKeyHash}`)
		expect(person.optOut).not.toBeNull()
		expect(person.records.length).toBeGreaterThan(0)
		expect(person.records.every((record) => record.email === known.email && record.payload)).toBe(true)
	})

	it('finds a mailed person by hash, cards included', async () => {
		const list = await get<{ recentlyMailed: { personKeyHash: string; email: string }[] }>('/api/suppressions/mailed')
		const mailed = list.recentlyMailed[0]!
		expect(personKeyHash(mailed.email)).toBe(mailed.personKeyHash)
		const person = await get<Person>(`/api/people/${mailed.personKeyHash}`)
		expect(person.cards.length).toBeGreaterThan(0)
		expect(person.cards[0]!.email).toBe(mailed.email)
	})

	it('refuses an opt-out for an email no contact has, and adds nothing', async () => {
		const refused = await call(app, '/api/suppressions', {
			cookie,
			method: 'POST',
			body: { email: 'Someone.New@Example.org', source: 'letter' },
		})
		expect(refused.status).toBe(404)
		expect(await refused.json()).toEqual({ error: 'No contact has that email address.' })
		const list = await get<{ optOuts: { personKeyHash: string }[] }>('/api/suppressions/opt-outs')
		expect(list.optOuts.some((row) => row.personKeyHash === personKeyHash('someone.new@example.org'))).toBe(false)
	})

	it('knows only the hash of an opt-out nobody lists, and says so with empty records', async () => {
		// The contact behind this opt-out is gone; the hash is all that is left.
		const hash = personKeyHash('gone.person@example.org')
		await t.db
			.insert(suppressions)
			.values({ personKeyHash: hash, reason: 'opt_out', source: 'letter', createdBy: 'usr_rep_tom', at: now })
		const list = await get<{ optOuts: { personKeyHash: string; email: string | null }[] }>(
			'/api/suppressions/opt-outs?q=letter',
		)
		expect(list.optOuts.find((row) => row.personKeyHash === hash)?.email).toBeNull()

		const person = await get<Person>(`/api/people/${hash}`)
		expect(person.records).toEqual([])
		expect(person.cards).toEqual([])
		expect(person.optOut?.source).toBe('letter')
	})

	it('refuses anything but a sha256 hash and needs a signed-in user', async () => {
		expect((await call(app, '/api/people/not-a-hash', { cookie })).status).toBe(400)
		expect((await call(app, `/api/people/${'0'.repeat(64)}`)).status).toBe(401)
	})
})

describe('the suppression lists, paged and searched on the server', () => {
	const t = useTestDb()
	let app: FetchApp
	let cookie: string

	interface OptOut {
		id: number
		at: string
		source: string | null
		createdBy: string
		personKeyHash: string
		email: string | null
		person: { fullName: string | null; title: string | null } | null
	}
	interface Mailed {
		cardId: number
		submittedAt: string
		personKeyHash: string
		email: string
		fullName: string | null
		campaignName: string
		until: string
	}
	interface Page<T> {
		total: number
		all: number
		pageSize: number
		nextCursor: string | null
		windowDays?: number
		optOuts?: T[]
		recentlyMailed?: T[]
		methods?: string[]
	}

	beforeAll(async () => {
		await seed(t.db, { now })
		const deps = testDeps(t.db, { clock: () => now })
		for (const provider of ['apollo', 'factset', 'clay'] as const) await runIngestion(deps, provider, 'system:test')
		await seedHistory(t.db, now)
		// Three opt-outs share each instant, so the id has to break the tie.
		await t.db.insert(suppressions).values(
			Array.from({ length: 25 }, (_, index) => ({
				personKeyHash: personKeyHash(`bulk-${index}@example.org`),
				reason: 'opt_out',
				source: index % 5 === 0 ? 'Letter_to_office' : 'letter',
				createdBy: 'usr_rep_tom',
				at: new Date(now.getTime() - Math.floor(index / 3) * 3_600_000),
			})),
		)
		// Every mailed card inside the window, five to a day, so the id breaks ties here too.
		await t.db.execute(
			sql`UPDATE cards SET submitted_at = ${now.toISOString()}::timestamptz - (id % 9) * interval '1 day' WHERE submitted_at IS NOT NULL`,
		)
		app = createTestApp(t.db, { clock: () => now })
		cookie = await loginAs(app, 'usr_rep_tom')
	})

	const list = async <T>(path: string) => {
		const response = await call(app, path, { cookie })
		expect(response.status).toBe(200)
		return (await response.json()) as Page<T>
	}
	// Every page of one list, following the cursors.
	const allPages = async <T>(path: string, key: 'optOuts' | 'recentlyMailed') => {
		const pages: Page<T>[] = []
		for (let cursor = ''; pages.length < 20;) {
			const page = await list<T>(`${path}${path.includes('?') ? '&' : '?'}cursor=${cursor}`)
			pages.push(page)
			if (!page.nextCursor) break
			cursor = page.nextCursor
		}
		return { pages, rows: pages.flatMap((page) => page[key]!) }
	}

	it('pages the opt-outs 20 at a time, newest first, without repeats, and ends with no cursor', async () => {
		const { pages, rows } = await allPages<OptOut>('/api/suppressions/opt-outs', 'optOuts')
		expect(pages.map((page) => page.optOuts!.length)).toEqual([20, 12])
		expect(pages[0]).toMatchObject({ total: 32, all: 32, pageSize: 20, nextCursor: expect.any(String) as string })
		expect(pages[1]!.nextCursor).toBeNull()
		expect(new Set(rows.map((row) => row.id)).size).toBe(32)
		const expected = (await t.db.select().from(suppressions)).sort(
			(a, b) => b.at.getTime() - a.at.getTime() || b.id - a.id,
		)
		expect(rows.map((row) => row.id)).toEqual(expected.map((row) => row.id))
		expect(pages[0]!.methods).toEqual(
			['Letter_to_office', 'email reply', 'letter', 'phone call', 'unsubscribe link'].sort((a, b) =>
				a.localeCompare(b),
			),
		)
	})

	it('searches opt-outs by method, by who added them, and by the name or email of a person a provider lists', async () => {
		const first = await list<OptOut>('/api/suppressions/opt-outs')
		const known = (await allPages<OptOut>('/api/suppressions/opt-outs', 'optOuts')).rows.find((row) => row.person)!
		const found = async (q: string) => await list<OptOut>(`/api/suppressions/opt-outs?q=${encodeURIComponent(q)}`)

		const byMethod = await found('  PHONE  ')
		expect(byMethod).toMatchObject({ total: 3, all: 32, nextCursor: null })
		expect(byMethod.optOuts!.every((row) => row.source === 'phone call')).toBe(true)
		// The user's name, not their id, as the page shows "Added by".
		expect((await found('okafor')).total).toBe(25)
		// What the page shows for an actor nobody knows is its id, so that is what matches.
		expect((await found('usr_rep')).total).toBe(0)
		expect((await found('system:seed')).total).toBe(7)
		expect((await found(known.email!.toUpperCase())).optOuts!.map((row) => row.id)).toContain(known.id)
		expect((await found(known.person!.fullName!)).optOuts!.map((row) => row.id)).toContain(known.id)
		// A search result pages too: five of the 25 "letter" rows are on the second page.
		const letters = await found('letter')
		expect(letters.total).toBe(25)
		expect(letters.optOuts).toHaveLength(20)
		expect(letters.nextCursor).not.toBeNull()
		expect(first.total).toBe(32)
	})

	it('treats LIKE wildcards in a search as plain characters', async () => {
		const percent = await list<OptOut>('/api/suppressions/opt-outs?q=%25')
		const underscore = await list<OptOut>('/api/suppressions/opt-outs?q=_')
		expect([percent.total, underscore.total]).toEqual([0, 5])
		expect((await list<Mailed>('/api/suppressions/mailed?q=%25')).total).toBe(0)
	})

	it('pages the mailed list newest first, 20 at a time, with the hold and the person to open', async () => {
		const { pages, rows } = await allPages<Mailed>('/api/suppressions/mailed', 'recentlyMailed')
		expect(pages.map((page) => page.recentlyMailed!.length)).toEqual([20, 20, 5])
		expect(pages[0]).toMatchObject({ total: 45, all: 45, pageSize: 20, windowDays: 90 })
		expect(pages[2]!.nextCursor).toBeNull()
		expect(new Set(rows.map((row) => row.cardId)).size).toBe(45)
		const times = rows.map((row) => new Date(row.submittedAt).getTime())
		expect([...times].sort((a, b) => b - a)).toEqual(times)
		// Same instant: the higher card id first.
		for (const [index, row] of rows.entries()) {
			const before = rows[index - 1]
			if (before && before.submittedAt === row.submittedAt) expect(before.cardId).toBeGreaterThan(row.cardId)
		}
		const [row] = rows
		expect(personKeyHash(row!.email)).toBe(row!.personKeyHash)
		expect(new Date(row!.until).getTime()).toBe(new Date(row!.submittedAt).getTime() + 90 * 86_400_000)
		// Only the name leaves the recipient, not the whole record.
		expect(Object.keys(row!).sort()).toEqual(
			[
				'campaignId',
				'campaignName',
				'cardId',
				'email',
				'fullName',
				'personKeyHash',
				'status',
				'submittedAt',
				'until',
			].sort(),
		)
	})

	it('keeps out cards mailed before the window', async () => {
		const [old] = await t.db
			.execute<{ id: number }>(sql`SELECT id FROM cards WHERE submitted_at IS NOT NULL LIMIT 1`)
			.then((r) => r.rows)
		await t.db.execute(
			sql`UPDATE cards SET submitted_at = ${now.toISOString()}::timestamptz - interval '91 days' WHERE id = ${old!.id}`,
		)
		expect((await list<Mailed>('/api/suppressions/mailed')).total).toBe(44)
		await t.db.execute(
			sql`UPDATE cards SET submitted_at = ${now.toISOString()}::timestamptz - interval '1 day' WHERE id = ${old!.id}`,
		)
		expect((await list<Mailed>('/api/suppressions/mailed')).total).toBe(45)
	})

	it('searches the mailed list by name, email and campaign', async () => {
		const { rows } = await allPages<Mailed>('/api/suppressions/mailed', 'recentlyMailed')
		const row = rows[0]!
		const found = async (q: string) => await list<Mailed>(`/api/suppressions/mailed?q=${encodeURIComponent(q)}`)
		for (const q of [row.fullName!, row.email.toUpperCase(), row.campaignName]) {
			const result = await found(q)
			expect(result.all).toBe(45)
			expect(result.recentlyMailed!.map((card) => card.cardId)).toContain(row.cardId)
			expect(result.total).toBe(
				rows.filter((card) =>
					[card.fullName, card.email, card.campaignName].some((text) => text?.toLowerCase().includes(q.toLowerCase())),
				).length,
			)
		}
		expect((await found('nobody is called this')).recentlyMailed).toEqual([])
	})

	it('refuses a bad cursor or search and needs a signed-in user', async () => {
		for (const path of ['/api/suppressions/opt-outs', '/api/suppressions/mailed']) {
			for (const cursor of ['nonsense', Buffer.from('["2026-11-20"]').toString('base64url'), 'x'.repeat(1001)])
				expect((await call(app, `${path}?cursor=${cursor}`, { cookie })).status).toBe(400)
			expect((await call(app, `${path}?q=${'x'.repeat(201)}`, { cookie })).status).toBe(400)
			expect((await call(app, path)).status).toBe(401)
		}
	})
})
