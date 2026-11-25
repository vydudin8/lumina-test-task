import { MAILED_WINDOW_DAYS } from '#common/settings.ts'
import { and, asc, count, desc, eq, getTableColumns, gte, ilike, inArray, isNotNull, like, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { AppDeps } from '../app.ts'
import { campaigns, cards, contacts, rawRecords, sourceCompanies, suppressions, users } from '../db/schema.ts'
import { addOptOut, launchSend, receiveMailWebhook, retrySend, retryUnconfirmed } from '../pipeline/send/store.ts'
import { personKey, personKeyHash } from '../policy/person-key.ts'
import { afterKey, cursorParam, decodeCursor, timestampKey, toPage } from './keyset.ts'
import { invalidRequest, readBody, readQuery } from './read-body.ts'
import { requireRole, requireUser, type AppEnv } from './session.ts'

const idParam = z.coerce.number().int().positive()
const optOutBody = z.object({
	email: z.string().trim().min(3).max(320),
	source: z.string().trim().max(200).default(''),
})
const emailQuery = z.object({ q: z.string().trim().min(1).max(320) })
const EMAIL_SUGGESTIONS = 5
const hashParam = z.string().regex(/^[0-9a-f]{64}$/)
// Both lists search with the typed text as part of a name, email or method; the typed text never reaches a log.
const listQuery = z.object({ q: z.string().trim().max(200).optional(), cursor: cursorParam })
const listKey = z.tuple([timestampKey, z.number().int()])
const PAGE_SIZE = 20

// `%` and `_` the user typed are plain characters, not wildcards.
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`)
const likePattern = (text: string) => `%${escapeLike(text)}%`

export function sendRoutes(deps: AppDeps) {
	const actorOf = (user: AppEnv['Variables']['user']) => ({ id: user!.id, role: user!.role })

	return new Hono<AppEnv>()
		.post('/campaigns/:id/send', requireRole('lead'), async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			return context.json(
				await launchSend(deps, {
					campaignId: id.data,
					actor: actorOf(context.var.user),
					requestId: context.var.requestId,
				}),
			)
		})
		.post('/cards/:id/retry', requireRole('lead'), async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			return context.json(
				await retrySend(deps, {
					cardId: id.data,
					actor: actorOf(context.var.user),
					requestId: context.var.requestId,
				}),
			)
		})
		.post('/campaigns/:id/retry-unconfirmed', requireRole('lead'), async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			return context.json(
				await retryUnconfirmed(deps, {
					campaignId: id.data,
					actor: actorOf(context.var.user),
					requestId: context.var.requestId,
				}),
			)
		})
		.get('/suppressions/opt-outs', requireUser, async (context) => {
			const query = readQuery(context, listQuery)
			if (!query) return invalidRequest(context)
			const key = query.cursor ? decodeCursor(listKey, query.cursor) : null
			if (query.cursor && !key) return invalidRequest(context)
			const pattern = query.q ? likePattern(query.q) : null
			// Opt-outs keep only a hash, so a typed name or email is matched against the contacts behind the hash, and
			// "added by" against the name the page shows (an id nobody knows shows as it is).
			const search = pattern
				? or(
						ilike(suppressions.source, pattern),
						ilike(sql`coalesce(${users.name}, ${suppressions.createdBy})`, pattern),
						sql`EXISTS (SELECT 1 FROM ${contacts} WHERE ${contacts.personKeyHash} = ${suppressions.personKeyHash} AND (${ilike(contacts.fullName, pattern)} OR ${ilike(contacts.title, pattern)} OR ${ilike(contacts.personKey, pattern)}))`,
					)
				: undefined
			const [{ all }] = (await deps.db.select({ all: count() }).from(suppressions)) as [{ all: number }]
			const [{ total }] = search
				? ((await deps.db
						.select({ total: count() })
						.from(suppressions)
						.leftJoin(users, eq(users.id, suppressions.createdBy))
						.where(search)) as [{ total: number }])
				: [{ total: all }]
			const rows = await deps.db
				.select({
					optOut: getTableColumns(suppressions),
					sortKey: sql<string>`${suppressions.at}::text`,
					createdByName: users.name,
				})
				.from(suppressions)
				.leftJoin(users, eq(users.id, suppressions.createdBy))
				.where(and(search, key ? afterKey([suppressions.at, suppressions.id], key, 'desc') : undefined))
				.orderBy(desc(suppressions.at), desc(suppressions.id))
				.limit(PAGE_SIZE + 1)
			const page = toPage(rows, PAGE_SIZE, (row) => [row.sortKey, row.optOut.id])
			// The same person can be listed by several providers; the first record stands for them.
			const known = new Map<string, { email: string; fullName: string | null; title: string | null }>()
			if (page.items.length) {
				const found = await deps.db
					.select({
						hash: contacts.personKeyHash,
						email: contacts.personKey,
						fullName: contacts.fullName,
						title: contacts.title,
					})
					.from(contacts)
					.where(
						inArray(
							contacts.personKeyHash,
							page.items.map((row) => row.optOut.personKeyHash),
						),
					)
					.orderBy(asc(contacts.id))
				for (const { hash, ...person } of found) if (!known.has(hash)) known.set(hash, person)
			}
			// Distinct methods feed the suggestions of the opt-out form, whatever page or search is showing.
			const methods = await deps.db
				.selectDistinct({ source: suppressions.source })
				.from(suppressions)
				.where(sql`btrim(${suppressions.source}) <> ''`)
			return context.json({
				total,
				all,
				pageSize: PAGE_SIZE,
				nextCursor: page.nextCursor,
				methods: methods.map((row) => row.source!.trim()).sort((a, b) => a.localeCompare(b)),
				optOuts: page.items.map(({ optOut }) => {
					const person = known.get(optOut.personKeyHash)
					// Only the hash is stored; a name and email show only while some provider still lists the person.
					return {
						...optOut,
						email: person?.email ?? null,
						person: person ? { fullName: person.fullName, title: person.title } : null,
					}
				}),
			})
		})
		.get('/suppressions/mailed', requireUser, async (context) => {
			const query = readQuery(context, listQuery)
			if (!query) return invalidRequest(context)
			const key = query.cursor ? decodeCursor(listKey, query.cursor) : null
			if (query.cursor && !key) return invalidRequest(context)
			const since = new Date(deps.clock().getTime() - MAILED_WINDOW_DAYS * 86_400_000)
			// isNotNull is implied by the date but names the predicate of the cards_submitted index.
			const inWindow = and(isNotNull(cards.submittedAt), gte(cards.submittedAt, since))
			const pattern = query.q ? likePattern(query.q) : null
			const search = pattern
				? or(
						ilike(sql`${cards.recipient}->>'fullName'`, pattern),
						ilike(cards.personKey, pattern),
						ilike(campaigns.name, pattern),
					)
				: undefined
			const [{ all }] = (await deps.db.select({ all: count() }).from(cards).where(inWindow)) as [{ all: number }]
			const [{ total }] = search
				? ((await deps.db
						.select({ total: count() })
						.from(cards)
						.innerJoin(campaigns, eq(cards.campaignId, campaigns.id))
						.where(and(inWindow, search))) as [{ total: number }])
				: [{ total: all }]
			const rows = await deps.db
				.select({
					cardId: cards.id,
					personKey: cards.personKey,
					fullName: sql<string | null>`${cards.recipient}->>'fullName'`,
					submittedAt: cards.submittedAt,
					sortKey: sql<string>`${cards.submittedAt}::text`,
					status: cards.status,
					campaignId: campaigns.id,
					campaignName: campaigns.name,
				})
				.from(cards)
				.innerJoin(campaigns, eq(cards.campaignId, campaigns.id))
				.where(and(inWindow, search, key ? afterKey([cards.submittedAt, cards.id], key, 'desc') : undefined))
				.orderBy(desc(cards.submittedAt), desc(cards.id))
				.limit(PAGE_SIZE + 1)
			const page = toPage(rows, PAGE_SIZE, (row) => [row.sortKey, row.cardId])
			return context.json({
				total,
				all,
				pageSize: PAGE_SIZE,
				nextCursor: page.nextCursor,
				windowDays: MAILED_WINDOW_DAYS,
				recentlyMailed: page.items.map((row) => ({
					cardId: row.cardId,
					fullName: row.fullName,
					// Mailed cards always name a person (cards_contact_consistency); the hash opens /people/:hash.
					email: row.personKey!,
					personKeyHash: personKeyHash(row.personKey!),
					submittedAt: row.submittedAt,
					until: new Date(row.submittedAt!.getTime() + MAILED_WINDOW_DAYS * 86_400_000).toISOString(),
					status: row.status,
					campaignId: row.campaignId,
					campaignName: row.campaignName,
				})),
			})
		})
		.get('/contacts/emails', requireUser, async (context) => {
			// Suggestions for the opt-out form. The request log records the path only, so the typed text never reaches it.
			const query = readQuery(context, emailQuery)
			if (!query) return invalidRequest(context)
			// Person keys are lower-cased emails; the typed text is a prefix, with LIKE's wildcards escaped.
			const pattern = `${escapeLike(personKey(query.q))}%`
			const rows = await deps.db
				.selectDistinct({ email: contacts.personKey })
				.from(contacts)
				.where(like(contacts.personKey, pattern))
				.orderBy(asc(contacts.personKey))
				.limit(EMAIL_SUGGESTIONS)
			return context.json({ emails: rows.map((row) => row.email) })
		})
		.get('/people/:hash', requireUser, async (context) => {
			// One person by the hash of their email: provider records with the raw JSON, the opt-out, and their cards.
			// An opt-out nobody lists any more keeps nothing but the hash, so records come back empty then.
			const hash = hashParam.safeParse(context.req.param('hash'))
			if (!hash.success) return invalidRequest(context)
			const records = await deps.db
				.select({
					id: contacts.id,
					provider: contacts.provider,
					externalId: contacts.externalId,
					email: contacts.personKey,
					fullName: contacts.fullName,
					title: contacts.title,
					seniority: contacts.seniority,
					functions: contacts.functions,
					emailStatus: contacts.emailStatus,
					fetchedAt: contacts.fetchedAt,
					companyId: sourceCompanies.companyId,
					companyName: sql<string | null>`${sourceCompanies.fields}->>'name'`,
					rawRecordId: rawRecords.id,
					payload: rawRecords.payload,
				})
				.from(contacts)
				.innerJoin(rawRecords, eq(rawRecords.id, contacts.rawRecordId))
				.leftJoin(sourceCompanies, eq(sourceCompanies.id, contacts.sourceCompanyId))
				.where(eq(contacts.personKeyHash, hash.data))
				.orderBy(asc(contacts.provider), asc(contacts.id))
			const [optOut] = await deps.db.select().from(suppressions).where(eq(suppressions.personKeyHash, hash.data))
			// Cards keep the email itself, so they match by its hash: a person no provider lists still finds theirs.
			const built = await deps.db
				.select({
					id: cards.id,
					status: cards.status,
					submittedAt: cards.submittedAt,
					email: cards.personKey,
					recipient: cards.recipient,
					campaignId: campaigns.id,
					campaignName: campaigns.name,
				})
				.from(cards)
				.innerJoin(campaigns, eq(cards.campaignId, campaigns.id))
				.where(sql`encode(sha256(convert_to(${cards.personKey}, 'UTF8')), 'hex') = ${hash.data}`)
				.orderBy(desc(cards.id))
			return context.json({
				records,
				optOut: optOut ?? null,
				cards: built.map(({ recipient, ...card }) => ({
					...card,
					fullName: recipient?.fullName ?? null,
					title: recipient?.title ?? null,
				})),
			})
		})
		.post('/suppressions', requireUser, async (context) => {
			const body = await readBody(context, optOutBody)
			if (!body) return invalidRequest(context)
			return context.json(
				await addOptOut(deps, {
					email: body.email,
					source: body.source,
					actor: actorOf(context.var.user),
					requestId: context.var.requestId,
				}),
			)
		})
}

// Not under /api: called by the print-and-mail provider, authenticated by its HMAC signature, not by a session.
export function webhookRoutes(deps: AppDeps) {
	// A webhook is a few hundred bytes; refuse anything big before reading it, signed or not.
	const limit = bodyLimit({
		maxSize: 64 * 1024,
		onError: (context) => context.json({ error: 'Payload too large' }, 413),
	})
	return new Hono<AppEnv>().post('/webhooks/mail', limit, async (context) => {
		const result = await receiveMailWebhook(
			{ db: deps.db, log: context.var.log, clock: deps.clock, webhookSecret: deps.webhookSecret },
			{ rawBody: await context.req.text(), signature: context.req.header('x-signature') },
		)
		return context.json(result.body, result.status)
	})
}
