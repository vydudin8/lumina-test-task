import { icpRulesSchema } from '#common/icp.ts'
import { and, asc, eq, gt, inArray, not, sql, type SQLWrapper } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.ts'
import { companyProfiles, companyScores } from '../db/schema.ts'
import { profileFields } from '../pipeline/resolve/store.ts'
import { scoreCompany } from '../pipeline/score/core.ts'
import {
	ensureScores,
	findRationale,
	getRationale,
	icpVersion,
	listIcpVersions,
	RANK_ORDER,
	rationaleEvidence,
	saveIcp,
	storedScore,
} from '../pipeline/score/store.ts'
import { cursorParam, decodeCursor, toPage } from './keyset.ts'
import { invalidRequest, readBody, readQuery } from './read-body.ts'
import { requireUser, type AppEnv } from './session.ts'

const rulesBody = z.object({ rules: icpRulesSchema })
const versionQuery = z.object({ version: z.coerce.number().int().positive().optional() })
const scoresQuery = versionQuery.extend({
	tab: z.enum(['in', 'out']).default('in'),
	q: z.string().trim().max(100).optional(),
	cursor: cursorParam,
})
const PAGE_SIZE = 20
// In the profile the cursor is the last row's exact score and company id; out of it, the company id.
const rankedKey = z.tuple([z.string().regex(/^\d+(\.\d+)?$/), z.number().int()])
const outKey = z.tuple([z.number().int()])
const idParam = z.coerce.number().int().positive()
const countWhere = (condition: SQLWrapper) => sql`count(*) filter (where ${condition})`.mapWith(Number)

export function scoreRoutes(deps: AppDeps) {
	const rationaleDeps = () => ({ db: deps.db, llm: deps.llm, log: deps.log, retry: deps.retry, clock: deps.clock })

	return new Hono<AppEnv>()
		.get('/icp', requireUser, async (context) => {
			const query = readQuery(context, versionQuery)
			if (!query) return invalidRequest(context)
			// current is the version asked for, the newest one by default.
			const current = await icpVersion(deps.db, query.version)
			return context.json({ current, versions: await listIcpVersions(deps.db) })
		})
		.post('/icp/preview', requireUser, async (context) => {
			const body = await readBody(context, rulesBody)
			if (!body) return invalidRequest(context)
			const p = companyProfiles
			const companies = await deps.db
				.select({
					companyId: p.companyId,
					name: p.name,
					industry: p.industry,
					country: p.country,
					headcount: p.headcount,
					revenueGbp: p.revenueGbp,
					signals: p.signals,
				})
				.from(p)
			const ranked: { companyId: number; name: string | null; display: number; earned: number }[] = []
			const reasons = new Map<string, number>()
			for (const company of companies) {
				const score = scoreCompany(body.rules, company)
				if (score.inProfile)
					ranked.push({
						companyId: company.companyId,
						name: company.name,
						display: score.display,
						// Points available are the same for every company, so points earned order exactly like the score.
						earned: score.contributions.reduce((sum, contribution) => sum + contribution.earned, 0),
					})
				else for (const reason of score.outReasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
			}
			ranked.sort((a, b) => b.earned - a.earned || a.companyId - b.companyId)
			return context.json({
				inProfile: ranked.length,
				outOfProfile: companies.length - ranked.length,
				reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
				top: ranked.slice(0, 10).map(({ companyId, name, display }) => ({ companyId, name, display })),
			})
		})
		.post('/icp', requireUser, async (context) => {
			const body = await readBody(context, rulesBody)
			if (!body) return invalidRequest(context)
			const user = context.var.user!
			const version = await saveIcp(deps.db, {
				rules: body.rules,
				actor: { id: user.id, role: user.role },
				requestId: context.var.requestId,
				now: deps.clock(),
			})
			return context.json({ version })
		})
		.get('/scores', requireUser, async (context) => {
			const query = readQuery(context, scoresQuery)
			if (!query) return invalidRequest(context)
			const icp = await icpVersion(deps.db, query.version)
			await ensureScores(deps.db, icp.id)
			const s = companyScores
			const p = companyProfiles
			const ofVersion = eq(s.icpVersionId, icp.id)
			const needle = query.q
			const named = (companyId: SQLWrapper) =>
				needle
					? inArray(
							companyId,
							deps.db
								.select({ id: p.companyId })
								.from(p)
								.where(sql`strpos(lower(${p.name}), lower(${needle})) > 0`),
						)
					: undefined

			const [counts] = (await deps.db
				.select({ inProfile: countWhere(s.inProfile), outOfProfile: countWhere(not(s.inProfile)) })
				.from(s)
				.where(and(ofVersion, named(s.companyId)))) as [{ inProfile: number; outOfProfile: number }]
			const page = { icp, counts, pageSize: PAGE_SIZE }

			if (query.tab === 'out') {
				const after = query.cursor ? decodeCursor(outKey, query.cursor) : null
				if (query.cursor && !after) return invalidRequest(context)
				const rows = await deps.db
					.select({ companyId: s.companyId, name: p.name, reasons: s.outReasons })
					.from(s)
					.innerJoin(p, eq(p.companyId, s.companyId))
					.where(and(ofVersion, not(s.inProfile), named(s.companyId), after ? gt(s.companyId, after[0]) : undefined))
					.orderBy(asc(s.companyId))
					.limit(PAGE_SIZE + 1)
				const { items, nextCursor } = toPage(rows, PAGE_SIZE, (row) => [row.companyId])
				return context.json({ ...page, total: counts.outOfProfile, nextCursor, ranked: [], outOfProfile: items })
			}

			const after = query.cursor ? decodeCursor(rankedKey, query.cursor) : null
			if (query.cursor && !after) return invalidRequest(context)
			// Ranks count every company in the profile, so a search shows each match with its real rank.
			const ranks = deps.db
				.select({
					companyId: s.companyId,
					score: s.score,
					rank: sql<number>`row_number() OVER (ORDER BY ${sql.join(RANK_ORDER, sql`, `)})`.mapWith(Number).as('rank'),
				})
				.from(s)
				.where(and(ofVersion, s.inProfile))
				.as('ranks')
			const rows = await deps.db
				.select({
					rank: ranks.rank,
					companyId: ranks.companyId,
					name: p.name,
					score: ranks.score,
					display: s.display,
					contributions: s.contributions,
				})
				.from(ranks)
				.innerJoin(s, and(ofVersion, eq(s.companyId, ranks.companyId)))
				.innerJoin(p, eq(p.companyId, ranks.companyId))
				.where(
					and(
						named(ranks.companyId),
						after
							? sql`${ranks.score} <= ${after[0]} AND (${ranks.score} < ${after[0]} OR ${ranks.companyId} > ${after[1]})`
							: undefined,
					),
				)
				.orderBy(asc(ranks.rank))
				.limit(PAGE_SIZE + 1)
			const { items, nextCursor } = toPage(rows, PAGE_SIZE, (row) => [row.score, row.companyId])
			return context.json({
				...page,
				total: counts.inProfile,
				nextCursor,
				ranked: items.map((row) => ({
					rank: row.rank,
					companyId: row.companyId,
					name: row.name,
					score: row.score,
					display: row.display,
					missed: row.contributions
						.filter((contribution) => contribution.outcome !== 'pass')
						.map((contribution) => ({ ruleId: contribution.ruleId, outcome: contribution.outcome })),
				})),
				outOfProfile: [],
			})
		})
		.get('/scores/:companyId', requireUser, async (context) => {
			const companyId = idParam.safeParse(context.req.param('companyId'))
			const query = readQuery(context, versionQuery)
			if (!companyId.success || !query) return invalidRequest(context)
			const icp = await icpVersion(deps.db, query.version)
			const fields = (await profileFields(deps.db, [companyId.data], deps.clock())).get(companyId.data)
			const stored = fields && (await storedScore(deps.db, icp.id, companyId.data))
			if (!fields || !stored) return context.json({ error: 'Company not found' }, 404)
			const company = { id: companyId.data, fields }

			const evidence = rationaleEvidence(company, stored.score, icp)
			return context.json({
				icp: { id: icp.id, rules: icp.rules },
				company: { id: company.id, name: company.fields.name.value, fields: company.fields },
				rank: stored.rank,
				score: stored.score,
				evidence,
				rationale: await findRationale(deps.db, company.id, icp.id, evidence),
			})
		})
		.post('/scores/:companyId/rationale', requireUser, async (context) => {
			const companyId = idParam.safeParse(context.req.param('companyId'))
			const query = readQuery(context, versionQuery)
			if (!companyId.success || !query) return invalidRequest(context)
			const icp = await icpVersion(deps.db, query.version)
			return context.json({ rationale: await getRationale(rationaleDeps(), companyId.data, icp.id) })
		})
}
