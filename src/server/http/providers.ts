import { PROVIDERS } from '#common/settings.ts'
import { and, count, countDistinct, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.ts'
import { ingestionRuns, rawRecords } from '../db/schema.ts'
import { runIngestion } from '../pipeline/ingest/index.ts'
import { invalidRequest, readQuery } from './read-body.ts'
import { requireUser, type AppEnv } from './session.ts'

const providerSchema = z.enum(PROVIDERS)
const rawRecordsQuery = z.object({
	provider: providerSchema.optional(),
	kind: z.enum(['company', 'contact']).optional(),
	runId: z.coerce.number().int().positive().optional(),
	q: z.string().trim().max(100).optional(),
	offset: z.coerce.number().int().min(0).default(0),
})
const PAGE_SIZE = 50

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
			const lastRuns = await db
				.selectDistinctOn([ingestionRuns.provider])
				.from(ingestionRuns)
				.orderBy(ingestionRuns.provider, desc(ingestionRuns.startedAt), desc(ingestionRuns.id))
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
			const run = await runIngestion({ ...deps, log: context.var.log }, provider.data, context.var.user!.id)
			return context.json({ run })
		})
		.get('/ingestion-runs', requireUser, async (context) => {
			const provider = providerSchema.optional().safeParse(context.req.query('provider'))
			if (!provider.success) return invalidRequest(context)
			const runs = await deps.db
				.select()
				.from(ingestionRuns)
				.where(provider.data ? eq(ingestionRuns.provider, provider.data) : undefined)
				.orderBy(desc(ingestionRuns.startedAt), desc(ingestionRuns.id))
				.limit(50)
			return context.json({ runs })
		})
		.get('/raw-records', requireUser, async (context) => {
			const query = readQuery(context, rawRecordsQuery)
			if (!query) return invalidRequest(context)

			const filters: (SQL | undefined)[] = [
				query.provider ? eq(rawRecords.provider, query.provider) : undefined,
				query.kind ? eq(rawRecords.kind, query.kind) : undefined,
				query.runId ? eq(rawRecords.runId, query.runId) : undefined,
			]
			if (query.q) {
				const pattern = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
				filters.push(or(ilike(rawRecords.externalId, pattern), ilike(sql`${rawRecords.payload}::text`, pattern)))
			}
			const where = and(...filters)

			const [{ total }] = (await deps.db.select({ total: count() }).from(rawRecords).where(where)) as [
				{ total: number },
			]
			const records = await deps.db
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
				.where(where)
				.orderBy(rawRecords.provider, rawRecords.kind, recordLabel)
				.limit(PAGE_SIZE)
				.offset(query.offset)
			return context.json({ total, offset: query.offset, pageSize: PAGE_SIZE, records })
		})
		.get('/raw-records/:id', requireUser, async (context) => {
			const id = z.coerce.number().int().positive().safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			const [record] = await deps.db.select().from(rawRecords).where(eq(rawRecords.id, id.data))
			if (!record) return context.json({ error: 'Record not found' }, 404)
			return context.json({ record })
		})
}
