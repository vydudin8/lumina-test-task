# Lumina outbound: targeting and postcards (Project 2)

Pulls company and contact data from Clay, Apollo and FactSet, merges it into one company master, scores companies against an editable ideal customer profile (ICP), and runs a postcard campaign through a print-and-mail API. The three providers and the print partner are fakes served over real HTTP by `fake-world`.

## Run it

```bash
docker compose up                                # http://localhost:3000, data seeded on first start
docker compose --profile test run --rm test      # typecheck, lint, unit + Postgres integration, Playwright
```

Pick a user in the header: **Maya Fernandes** is the sales lead (the only role that can approve and send); Tom Okafor and Ana Kowalski are reps. With `ANTHROPIC_API_KEY` set, Claude Haiku (`claude-haiku-5-5`) writes the AI lines; without it a deterministic stub does, and invents a number in about one line in nine so you can see the guard reject it. Fake-world switches (lost responses, 500s, duplicate or shuffled webhooks): `POST localhost:4000/__control`, e.g. `{"mode":"timeout_once"}`; `GET /__calls` lists what it received.

Without Docker: Postgres 17, `cp .env.example .env`, `pnpm install`, `pnpm seed:reset`, `pnpm dev`; tests with `pnpm test` and `pnpm test:e2e`.

## The example conditions, as tests

| Condition                                                                                                                          | Test                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 300 company and 600 contact records; fixtures regenerate byte for byte; seed twice gives the same state                            | `scripts/generate-fixtures.test.ts`, `src/server/seed/seed.db.test.ts` |
| Exactly 18 merges, no false merges, 7 headcount conflicts                                                                          | `src/server/pipeline/resolve/resolve.db.test.ts`                       |
| Default ICP puts the expected 50 companies on top                                                                                  | `src/server/pipeline/score/score.db.test.ts`                           |
| Top 50 → exactly 39 eligible cards (8 suppressed, 3 bad addresses)                                                                 | `src/server/pipeline/campaign/campaign.db.test.ts`                     |
| Skipped companies stay on the list with their reason, including one with no contact on file                                        | `campaign.db.test.ts`, `e2e/campaigns.spec.ts`                         |
| Providers that disagree on an address: flagged on the company and on the card, with the source                                     | `src/server/pipeline/resolve/*.test.ts`, `e2e/campaigns.spec.ts`       |
| A rep cannot approve, through the API or direct SQL; a repeated approve is a no-op                                                 | `campaign.db.test.ts`, `src/server/http/campaigns.db.test.ts`          |
| An opt-out after approval blocks the send and the mail API gets 0 calls; a timeout plus retry gives one postcard and one `mail_id` | `src/server/pipeline/send/send.db.test.ts`                             |
| Webhook signature, duplicates, out-of-order events, unknown mail id                                                                | `src/server/http/webhooks.db.test.ts`                                  |
| A status reaches the UI within 5 s                                                                                                 | `e2e/send.spec.ts`                                                     |
| A day-35 event is not attributed                                                                                                   | `src/server/pipeline/results/*.test.ts`                                |
| The guard rejects an uncited number and an unknown citation with the right codes                                                   | `src/server/llm/guard.test.ts`                                         |

`fixtures/manifest.json` is the ground truth the tests compare against; `pnpm fixtures` regenerates it from a seeded PRNG.

## Decisions

- **Modular monolith.** Ingest → resolve → score → campaign → send → results are modules that hand data over through tables (pure `core.ts`, I/O in `store.ts`). Separate services would split the transactions that matter (approval plus its audit row; the send re-check plus the submission) and move permission checks out of the database.
- **The database enforces the rules.** Approved-or-later cards need `approved_by`; a composite FK `(approved_by, approved_by_role) → users(id, role)` plus `CHECK approved_by_role = 'lead'` means even direct SQL cannot record a rep's approval. Launching a send has the same pair. `audit_events` is append-only by trigger and written in the same transaction as each change. ICP versions are immutable.
- **One card per company, no substitution.** The recipient is chosen by a fixed chain that ignores eligibility: target function (operations, then fleet/plant, procurement, sustainability), seniority, providers corroborating the person, freshest record, contact id. Every card shows the rule that picked its person, and who else was considered, under "Why this person". If that person opted out, was mailed in the last 90 days, or the office address is invalid, the card is blocked with that reason; we never fall back to a colleague. A company with no contact on file is kept as a blocked "no contact" card, so no company leaves the list silently. Suppression and the address are checked again at send time. Cards go to the company office address with the person's name, because no provider has personal postal addresses. The address is not a tie-break: it is the same office for everyone at the company, so it decides whether the company gets a card, not who gets it.
- **Provenance per field.** Every value names its provider, raw record, the provider's own date and our fetch time. Precedence is set per field (headcount and revenue: FactSet, Apollo, Clay). Headcount and revenue conflict above a 10% difference, other fields when normalised values differ. Choosing a value, merging or splitting needs a reason, is audited, and is keyed on source records so it survives re-pulls. Addresses follow the same rule: a card snapshots where its address came from, and says so when the providers disagree.
- **Money and scores are exact.** `numeric` in Postgres, `decimal.js` in code. Revenue is converted to GBP with seeded `fx_rates`, and the original amount, rate and date are shown next to every converted value. Scores are exact decimals, displayed rounded half up, ordered by exact value then company id.
- **The LLM only rephrases evidence.** It gets numbered facts (first name, title, company facts; never email or address) and must answer `{text, cites}`. The guard rejects invalid JSON, empty or long text, missing or unknown citations, any number not in the cited evidence (digits, number words, a changed £/$/% sign), and contact data. A rejected answer is replaced by a template, keeps its raw output and reason codes, shows a badge and writes an audit event. It never picks recipients or changes scores.
- **Idempotent everywhere:** fixtures and seed, ingestion (raw records unique on content hash), campaign creation (`Idempotency-Key`), approvals and send launch (conditional updates), submission (a per-card key generated at approval), webhooks (unique event id), opt-outs, manual outcomes.
- **Retries with full jitter** (`lib/retry.ts`, honours `Retry-After`) for provider pulls, mail submissions, LLM calls and fake-world's webhook redelivery. The send worker claims cards with `FOR UPDATE SKIP LOCKED`, re-checks suppression and the address, and records every attempt. A card the printer never answered for is `unconfirmed`, not failed: it holds the person back, and a lead retries it with the same key.
- **Time is injected.** Seeded mailings, opt-outs and outcomes are dated relative to the seed run, so the 90-day hold and 30-day attribution hold whenever it runs. Provider "as of" dates are fixed, so FactSet figures turn stale as real time passes.

## Manual and automated

**People decide:** approving each card, launching the send, uncertain merges, choosing a value in a conflict, ICP changes, logging replies and meetings, what to do with a `failed` card. **The system does:** ingestion, normalisation, confident merges, scoring, drafting lines (guarded), address validation, suppression, retries, webhooks, attribution.

## Assumptions

Confirmed by the hiring team: one card per company with a recipient rule of our choosing, shown in the UI; no fallback recipient, so the top 50 gives 50 − 11 = 39 cards, and skipped companies are shown with their reason; suppression is checked again at send time; the mailing address is the company office with the contact's name, and address disagreements are treated like any other conflict. Our calls: "300 companies and 600 contacts" are raw records (282 unique companies); A/B alternates in rank order within one campaign; Apollo's `annual_revenue` is USD; FactSet has no industry field, so FactSet-only companies are out with "industry unknown" rather than guessed; we post to GB, IE, FR, DE, NL; ICP signals are static so the top 50 does not drift; real Clay pushes rows, our fake is pulled.

## Personal data

Lawful basis: B2B legitimate interest. Logs redact names, emails, phones and addresses; opt-outs keep only a SHA-256 of the normalised email, so they outlive the contact record; the LLM never sees an email or address.

## Not built yet

Re-checking an address after a `returned` postcard, live FX rates, erasure on request, an outcome simulator, FactSet industry classification, a lease so several send workers can run (one worker holds the row lock during retries; marked `shortcut:`), real authentication.

## For the sales lead

Go through the menu left to right. Click any number to see where it came from, down to the raw provider data. Build a campaign, read the cards (blocked ones say why), approve, press **Send**; statuses update by themselves. Results compares the two designs and says when the sample is too small to trust.

Built with Claude Code as a pair programmer; every line was reviewed. `CLAUDE.md` holds the working conventions.
