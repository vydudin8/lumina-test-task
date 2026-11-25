import { PROVIDERS } from '#common/settings.ts'
import {
	and,
	count,
	countDistinct,
	desc,
	eq,
	getTableColumns,
	ilike,
	inArray,
	ne,
	notInArray,
	or,
	sql,
	type SQL,
} from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.ts'
import { ingestionRunRecords, ingestionRuns, rawRecords } from '../db/schema.ts'
import { enqueuePull } from '../pipeline/ingest/index.ts'
import { afterKey, cursorParam, decodeCursor, timestampKey, toPage } from './keyset.ts'
import { invalidRequest, readQuery } from './read-body.ts'
import { requireUser, type AppEnv } from './session.ts'

const providerSchema = z.enum(PROVIDERS)
const ACTIVE = ['queued', 'running']
const rawRecordsQuery = z
	.object({
		provider: providerSchema.optional(),
		kind: z.enum(['company', 'contact']).optional(),
		// Records the run received; `outcome` narrows them to the ones it added or the ones it saw again unchanged.
		runId: z.coerce.number().int().positive().optional(),
		outcome: z.enum(['new', 'unchanged']).optional(),
		q: z.string().trim().max(100).optional(),
		cursor: cursorParam,
	})
	.refine((query) => !query.outcome || query.runId)
const recordsKey = z.tuple([z.string(), z.string(), z.string(), z.number().int()])
const PAGE_SIZE = 20

const runsQuery = z.object({ provider: providerSchema.optional(), cursor: cursorParam })
const runsKey = z.tuple([timestampKey, z.number().int()])
const RUNS_PAGE_SIZE = 15
// Lists leave out the rejected payloads; one run's page loads them.
const { errors, ...runListColumns } = getTableColumns(ingestionRuns)

const recordLabel = sql<string>`coalesce(
	${rawRecords.payload}->>'name',
	${rawRecords.payload}->'entity_reference'->>'entity_proper_name',
	${rawRecords.payload}->>'Company Name',
	${rawRecords.payload}->>'Full Name',
	${rawRecords.externalId}
)`

export function providerRoutes(deps: AppDeps) {
	return new Hono<AppEnv>()
		.get('/providers', requireUser, async (context) => {
			const { db } = deps
			// The panel's numbers are the last pull that ended; one still waiting or running is reported next to it.
			const latest = (active: boolean) =>
				db
					.selectDistinctOn([ingestionRuns.provider])
					.from(ingestionRuns)
					.where(active ? inArray(ingestionRuns.status, ACTIVE) : notInArray(ingestionRuns.status, ACTIVE))
					.orderBy(ingestionRuns.provider, desc(ingestionRuns.startedAt), desc(ingestionRuns.id))
			const [lastRuns, activeRuns] = await Promise.all([latest(false), latest(true)])
			const records = await db
				.select({ provider: rawRecords.provider, kind: rawRecords.kind, n: countDistinct(rawRecords.externalId) })
				.from(rawRecords)
				.groupBy(rawRecords.provider, rawRecords.kind)
			const totals = await db
				.select({
					provider: ingestionRuns.provider,
					runs: count(),
					credits: sql<string>`coalesce(sum(${ingestionRuns.creditsUsed}), 0)::text`,
				})
				.from(ingestionRuns)
				.groupBy(ingestionRuns.provider)

			const providers = PROVIDERS.map((provider) => {
				const recordCount = (kind: string) =>
					records.find((row) => row.provider === provider && row.kind === kind)?.n ?? 0
				const total = totals.find((row) => row.provider === provider)
				return {
					provider,
					lastRun: lastRuns.find((run) => run.provider === provider) ?? null,
					activeRun: activeRuns.find((run) => run.provider === provider) ?? null,
					records: { company: recordCount('company'), contact: recordCount('contact') },
					runs: total?.runs ?? 0,
					creditsTotal: total?.credits ?? '0',
				}
			})
			return context.json({ providers })
		})
		.post('/providers/:provider/pull', requireUser, async (context) => {
			const provider = providerSchema.safeParse(context.req.param('provider'))
			if (!provider.success) return context.json({ error: 'Unknown provider' }, 404)
			// The job runner does the pull; the Providers page follows the run row, which says queued, then running.
			const { job, run, created } = await enqueuePull(deps.db, deps.clock, provider.data, context.var.user!.id)
			return context.json({ run, jobId: job.id, created }, 202)
		})
		.get('/ingestion-runs', requireUser, async (context) => {
			const query = readQuery(context, runsQuery)
			if (!query) return invalidRequest(context)
			const filter = query.provider ? eq(ingestionRuns.provider, query.provider) : undefined
			const key = query.cursor ? decodeCursor(runsKey, query.cursor) : null
			if (query.cursor && !key) return invalidRequest(context)

			const [{ total }] = (await deps.db.select({ total: count() }).from(ingestionRuns).where(filter)) as [
				{ total: number },
			]
			const rows = await deps.db
				.select({
					...runListColumns,
					errorCount: sql<number>`jsonb_array_length(${errors})`,
					sortKey: sql<string>`${ingestionRuns.startedAt}::text`,
				})
				.from(ingestionRuns)
				.where(and(filter, key ? afterKey([ingestionRuns.startedAt, ingestionRuns.id], key, 'desc') : undefined))
				.orderBy(desc(ingestionRuns.startedAt), desc(ingestionRuns.id))
				.limit(RUNS_PAGE_SIZE + 1)
			const page = toPage(rows, RUNS_PAGE_SIZE, (run) => [run.sortKey, run.id])
			return context.json({
				total,
				pageSize: RUNS_PAGE_SIZE,
				nextCursor: page.nextCursor,
				runs: page.items.map(({ sortKey, ...run }) => run),
			})
		})
		.get('/ingestion-runs/:id', requireUser, async (context) => {
			const id = z.coerce.number().int().positive().safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			const [run] = await deps.db.select().from(ingestionRuns).where(eq(ingestionRuns.id, id.data))
			if (!run) return context.json({ error: 'Run not found' }, 404)
			return context.json({ run })
		})
		.get('/raw-records', requireUser, async (context) => {
			const query = readQuery(context, rawRecordsQuery)
			if (!query) return invalidRequest(context)
			const key = query.cursor ? decodeCursor(recordsKey, query.cursor) : null
			if (query.cursor && !key) return invalidRequest(context)

			const filters: (SQL | undefined)[] = [
				query.provider ? eq(rawRecords.provider, query.provider) : undefined,
				query.kind ? eq(rawRecords.kind, query.kind) : undefined,
				query.runId
					? inArray(
							rawRecords.id,
							deps.db
								.select({ id: ingestionRunRecords.rawRecordId })
								.from(ingestionRunRecords)
								.where(eq(ingestionRunRecords.runId, query.runId)),
						)
					: undefined,
				query.runId && query.outcome === 'new' ? eq(rawRecords.runId, query.runId) : undefined,
				query.runId && query.outcome === 'unchanged' ? ne(rawRecords.runId, query.runId) : undefined,
			]
			if (query.q) {
				const pattern = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
				filters.push(or(ilike(rawRecords.externalId, pattern), ilike(sql`${rawRecords.payload}::text`, pattern)))
			}
			const where = and(...filters)
			const sortKey = [rawRecords.provider, rawRecords.kind, recordLabel, rawRecords.id]

			const [{ total }] = (await deps.db.select({ total: count() }).from(rawRecords).where(where)) as [
				{ total: number },
			]
			const rows = await deps.db
				.select({
					id: rawRecords.id,
					provider: rawRecords.provider,
					kind: rawRecords.kind,
					externalId: rawRecords.externalId,
					label: recordLabel,
					runId: rawRecords.runId,
					fetchedAt: rawRecords.fetchedAt,
					lastSeenAt: rawRecords.lastSeenAt,
				})
				.from(rawRecords)
				.where(and(where, key ? afterKey(sortKey, key, 'asc') : undefined))
				.orderBy(...sortKey)
				.limit(PAGE_SIZE + 1)
			const page = toPage(rows, PAGE_SIZE, (row) => [row.provider, row.kind, row.label, row.id])
			return context.json({ total, pageSize: PAGE_SIZE, nextCursor: page.nextCursor, records: page.items })
		})
		.get('/raw-records/:id', requireUser, async (context) => {
			const id = z.coerce.number().int().positive().safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			const [record] = await deps.db.select().from(rawRecords).where(eq(rawRecords.id, id.data))
			if (!record) return context.json({ error: 'Record not found' }, 404)
			return context.json({ record })
		})
}
