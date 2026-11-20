import { icpRulesSchema } from '#common/icp.ts'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.ts'
import { loadMaster } from '../pipeline/resolve/store.ts'
import {
	findRationale,
	getRationale,
	icpVersion,
	listIcpVersions,
	rationaleEvidence,
	saveIcp,
	scoreCompanies,
} from '../pipeline/score/store.ts'
import { invalidRequest, readBody, readQuery } from './read-body.ts'
import { requireUser, type AppEnv } from './session.ts'

const rulesBody = z.object({ rules: icpRulesSchema })
const versionQuery = z.object({ version: z.coerce.number().int().positive().optional() })
const idParam = z.coerce.number().int().positive()

export function scoreRoutes(deps: AppDeps) {
	const rationaleDeps = () => ({ db: deps.db, llm: deps.llm, log: deps.log, retry: deps.retry, clock: deps.clock })

	return new Hono<AppEnv>()
		.get('/icp', requireUser, async (context) => {
			const current = await icpVersion(deps.db, undefined)
			return context.json({ current, versions: await listIcpVersions(deps.db) })
		})
		.post('/icp/preview', requireUser, async (context) => {
			const body = await readBody(context, rulesBody)
			if (!body) return invalidRequest(context)
			const { companies } = await loadMaster(deps.db, deps.clock())
			const { ranked, outOfProfile } = scoreCompanies(companies, {
				id: 0,
				rules: body.rules,
				createdBy: '',
				createdAt: new Date(),
			})
			const reasons = new Map<string, number>()
			for (const row of outOfProfile)
				for (const reason of row.score.outReasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
			return context.json({
				inProfile: ranked.length,
				outOfProfile: outOfProfile.length,
				reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
				top: ranked.slice(0, 10).map((row) => ({
					companyId: row.company.id,
					name: row.company.fields.name.value,
					display: row.score.display,
				})),
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
			const query = readQuery(context, versionQuery)
			if (!query) return invalidRequest(context)
			const icp = await icpVersion(deps.db, query.version)
			const { ranked, outOfProfile } = scoreCompanies((await loadMaster(deps.db, deps.clock())).companies, icp)
			return context.json({
				icp,
				ranked: ranked.map((row) => ({
					rank: row.rank,
					companyId: row.company.id,
					name: row.company.fields.name.value,
					score: row.score.score,
					display: row.score.display,
					missed: row.score.contributions
						.filter((contribution) => contribution.outcome !== 'pass')
						.map((contribution) => ({ ruleId: contribution.ruleId, outcome: contribution.outcome })),
				})),
				outOfProfile: outOfProfile.map((row) => ({
					companyId: row.company.id,
					name: row.company.fields.name.value,
					reasons: row.score.outReasons,
				})),
			})
		})
		.get('/scores/:companyId', requireUser, async (context) => {
			const companyId = idParam.safeParse(context.req.param('companyId'))
			const query = readQuery(context, versionQuery)
			if (!companyId.success || !query) return invalidRequest(context)
			const icp = await icpVersion(deps.db, query.version)
			const { companies } = await loadMaster(deps.db, deps.clock())
			const company = companies.find((candidate) => candidate.id === companyId.data)
			if (!company) return context.json({ error: 'Company not found' }, 404)

			const all = scoreCompanies(companies, icp)
			const ranked = all.ranked.find((row) => row.company.id === company.id)
			const score = ranked?.score ?? all.outOfProfile.find((row) => row.company.id === company.id)!.score
			const evidence = rationaleEvidence(company, score, icp)
			return context.json({
				icp: { id: icp.id, rules: icp.rules },
				company: { id: company.id, name: company.fields.name.value, fields: company.fields },
				rank: ranked?.rank ?? null,
				score,
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
