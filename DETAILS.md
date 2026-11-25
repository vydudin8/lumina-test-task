# Lumina outbound: details

Reference for [README.md](README.md).

## Tests for the brief

| Requirement                                                              | Test                                                                   |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 18 merges, no false ones, 7 headcount conflicts, merge and unmerge       | `src/server/pipeline/resolve/resolve.db.test.ts`                       |
| Top 50 gives 39 cards, 11 blocked with their reasons                     | `src/server/pipeline/campaign/campaign.db.test.ts`                     |
| Opt-out after approval is blocked at send; timeout + retry, one postcard | `src/server/pipeline/send/send.db.test.ts`                             |
| Webhook signature, duplicates, out-of-order events, unknown mail id      | `src/server/http/webhooks.db.test.ts`                                  |
| Status in the UI within 5 s                                              | `e2e/send.spec.ts`                                                     |
| 30-day attribution, A/B counts                                           | `src/server/pipeline/results/core.test.ts`                             |
| LLM guard                                                                | `src/server/llm/guard.test.ts`                                         |
| Fixtures and seed are deterministic                                      | `scripts/generate-fixtures.test.ts`, `src/server/seed/seed.db.test.ts` |

## How each step works

1. **Ingestion.** A pull is a background job. Rows missing a key field (id, name, valid email) are kept as errors with their payload. Raw records are unique on a content hash, so a re-pull adds nothing. Credits are simulated per record received.
2. **Entity resolution.** Normalise domain, name (lower case, no punctuation or legal suffix such as Ltd) and country. Union-find links records, strongest first: manual merge, same domain, same name and country. An automatic link never adds a second domain or undoes a manual split. Same name with another domain or country goes to "possible duplicates" for a person. Merges, splits and value choices are keyed on source records, so they survive re-pulls; cards follow their recipient's record, so outreach history survives merge and unmerge.
3. **ICP editor.** Up to 20 rules (industry, country, headcount, revenue in GBP, signals), each with points and a "required" flag. Edits update the in/out count live; saving creates an immutable version.
4. **Fit score.** `earned points / available points × 100`. Unknown values earn 0; a failed or unknown required rule puts the company out, with the reason. The panel shows every rule's outcome and a one-line LLM rationale.
5. **Campaign builder.** Top N in-profile companies, one or two templates (A/B alternates in rank order). The LLM drafts each personal line. Anyone can edit or reject a card; only the lead approves, singly or in bulk.
6. **Send pipeline.** The worker re-checks suppression and the address, then submits with the card's `Idempotency-Key` (created at approval, same body on every retry). A 4xx makes the card `failed`. If every attempt timed out, it is `unconfirmed`: the person stays held and the lead retries with the same key. Webhooks need a valid HMAC signature under 5 minutes old, are stored once per event id and only move a status forward. A reconciler polls the provider for cards stuck in one status.
7. **Results.** A reply, visit or meeting counts for a mailed card when the company domain or the person's email matches, within 30 days of mailing. Rates are per card sent, per template; under 100 cards per template the comparison says the sample is too small.

## Hard-coded rules

Provider precedence (`src/common/settings.ts`). The first provider with a value wins:

| Field                   | Order                   | Why                                                  |
| ----------------------- | ----------------------- | ---------------------------------------------------- |
| Headcount, revenue      | FactSet > Apollo > Clay | FactSet figures come from dated filings              |
| Country, office address | FactSet > Apollo > Clay | FactSet gives the registered headquarters            |
| Name                    | Apollo > FactSet > Clay | FactSet and Clay often send names in capitals        |
| Domain, industry        | Apollo > Clay > FactSet | Apollo has a primary domain; FactSet has no industry |
| Signals                 | Union of all            | Every reported signal counts                         |

- **Conflicts:** headcount and revenue when `(max − min) / max > 10%`; other fields when normalised values differ. Values older than 18 months are marked stale.
- **Windows:** suppression 90 days, attribution 30 days.
- **Addresses:** GB, IE, FR, DE, NL only, each with its postcode pattern; street, city and postcode required.
- **Signals:** `fleet_telematics` (Apollo lists Geotab, Samsara, Webfleet or Verizon Connect), `funded` (Apollo `total_funding > 0`), `net_zero_target` (Clay).
- **Default ICP** (`src/server/seed/defaults.ts`): plant hire, construction, civil engineering or quarrying (30, required); GB or IE (20, required); 50 to 5,000 staff (20); revenue from £10m (20); any signal (10).
- **Simulated:** credit prices, FX rates, the map from provider industry labels to ours.

## Where things are

| Path                           | What                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `src/fake-world/`              | Fake provider APIs serving `fixtures/`, fake mail API with signed webhooks                     |
| `scripts/generate-fixtures.ts` | Seeded fixture generator; `fixtures/manifest.json` is the tests' ground truth                  |
| `src/server/pipeline/<step>/`  | `ingest`, `resolve`, `score`, `campaign`, `send`, `results`: pure `core.ts`, I/O in `store.ts` |
| `src/server/policy/`           | Recipient choice, address validation, suppression                                              |
| `src/server/llm/`              | Claude client, stub, prompts, output guard                                                     |
| `src/server/db/`               | Drizzle schema; CHECKs, FKs and triggers that enforce approvals and audit                      |
| `src/common/settings.ts`       | All thresholds and provider precedence, shared by server and UI                                |
| `src/client/pages/`            | React UI, one page per step of the brief                                                       |
| `src/client/components/`       | React components; `campaign/` builds the campaign page, `ui/` holds vendored shadcn/ui         |
| `src/client/domain/`           | UI-side logic for Lumina concepts: audit labels, campaign stages, LLM draft checks, session    |
| `src/client/lib/`              | Helpers with no domain knowledge: API fetch, formatting, list state in the URL, live updates   |

Stack: Node 24 (TypeScript without a build step), Hono, Postgres 17 + Drizzle, React 19 + TanStack Query, Vitest, Playwright.
