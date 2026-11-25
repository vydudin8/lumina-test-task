import { createCampaign, writeLines, type CampaignDeps, type CreateCampaignInput } from '../pipeline/campaign/store.ts'

// A campaign as the screens see it once the job runner has written its lines.
export async function createCampaignWithLines(deps: CampaignDeps, input: CreateCampaignInput) {
	const result = await createCampaign(deps, input)
	await writeLines(deps, result.campaign.id)
	return result
}
