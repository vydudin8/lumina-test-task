# Lumina outbound

Turns company data from Clay, Apollo and FactSet into one company master, scores it against an editable ideal customer profile (ICP) and runs a postcard campaign. The providers and the print-and-mail API are fakes served over real HTTP by `fake-world`. Nothing is mailed.

## Run

```bash
docker compose up                              # http://localhost:3000, seeded on first start
docker compose --profile test run --rm test    # typecheck, lint, unit, Postgres integration, Playwright
```

Without Docker you need Node 24, pnpm and Postgres 17 with a role that can create databases (`CREATE ROLE lumina LOGIN PASSWORD 'lumina' CREATEDB;`); no other credentials. Then `cp .env.example .env`, `pnpm install`, `pnpm dev`, and `pnpm seed:reset` in a second terminal.

Tests: `pnpm test:all` runs all of them. `pnpm test` is typecheck, lint, unit and Postgres integration; `pnpm test:e2e` is Playwright.

Which test covers each condition of the brief, how each step works, the hard-coded rules and a map of the code are in [DETAILS.md](DETAILS.md).

- **Users:** pick one in the header, no passwords. Maya Fernandes is the sales lead, the only role that can approve and send; Tom Okafor and Ana Kowalski are reps.
- **LLM:** a deterministic stub, by design. The app, the guard and every test were built against it. It writes each line from the evidence it gets and invents a number about once in nine, so the guard has something to reject. A real model is optional: with `ANTHROPIC_API_KEY` in `.env` (read by `pnpm dev` and `docker compose`), the same interface calls Claude Haiku (`claude-haiku-5-5`). We did not develop or tune the app against a real key. Prompts, model choice, cost and latency all have a lot of room for improvement, and that work was out of scope.
- **Fake world:** `POST localhost:4000/__control` with `{"mode":"timeout_once"}`, `timeout_always`, `error_500_once`, `{"duplicate_rate":0.5}` or `{"shuffle":true}`; `GET /__calls` lists what it received. A postcard moves one status every 5 s; 1 in 5 ends `returned`.

## Recipient rule

One card per company. Contacts are grouped into people by normalised work email. The first step that tells two people apart decides:

1. Target function: operations, then fleet or plant, then procurement, then sustainability (provider function labels or title keywords).
2. Seniority: C-suite, VP, director, head, manager, other.
3. Known to more providers.
4. Freshest record, then lowest contact id.

Eligibility is not part of the rule, so a suppressed person is never swapped for a colleague. Each card shows "Why this person": the deciding step and the other candidates.

## Assumptions

Confirmed by the hiring team:

- One card per company, no fallback contact. The top 50 gives 39 cards; the other 11 stay on the list with their reason (5 opted out, 3 mailed in the last 90 days, 3 invalid addresses). A company with no contact stays as a blocked "no contact" card.
- Suppression is checked when cards are built and again at send time.
- Cards go to the company office address with the contact's name. Providers that disagree on an address are a conflict, shown with its source on the company and the card.

Our own calls:

- "300 companies and 600 contacts" are raw records: 282 real companies after 18 merges.
- Apollo's `annual_revenue` is USD. All revenue is converted to GBP at seeded rates; the original amount and rate are shown.
- FactSet has no industry, so FactSet-only companies are "industry unknown" and fail the required rule rather than get a guess.
- Website visits come from seeded history (no tracking script); replies and meetings are logged manually.
- Real Clay pushes rows; our fake is pulled like the others.
- Seeded history is dated relative to the seed run, so the 90- and 30-day windows hold whenever it runs.

## Manual and automated

Kept manual:

- **Approval and launching the send:** they spend money and speak for the brand, and the brief requires it.
- **Uncertain merges:** a wrong merge mixes two companies' outreach history; a missed duplicate only costs a second look.
- **Choosing a value in a conflict:** needs judgement; precedence applies until then.
- **ICP changes:** a business decision, saved as versions.
- **Replies and meetings:** they arrive by email and phone; there is no CRM integration.
- **Failed and unconfirmed cards:** the cause should be seen and fixed before a retry.

Automated: ingestion, confident merges, scoring, drafting lines, address validation, suppression, retries, webhooks, attribution.

## Engineering decisions

- **Modular monolith on Postgres only.** Jobs are a table, live updates are `LISTEN/NOTIFY` over SSE; no queue, no Redis. An approval and its audit row, or the send re-check and the submission, share one transaction.
- **The database enforces the rules.** A composite FK on `(approved_by, approved_by_role)` plus `CHECK approved_by_role = 'lead'` blocks a rep's approval even through direct SQL. The audit log is append-only by trigger. Money and scores are `numeric` and `decimal.js`.
- **The LLM only rephrases evidence.** It gets numbered facts (first name, title, company facts; never email or address) and must cite them. The guard rejects uncited numbers, unknown citations, contact data and bad JSON; a rejected line falls back to a template and is flagged. Logs redact contact details; an opt-out keeps only a SHA-256 of the email.

## Left out on purpose

- **Fuzzy name matching for automatic merges.** A false merge mixes two companies' outreach history; a missed duplicate only costs a second look, so near matches go to a person.
- **Microservices and a message queue.** One server and Postgres cover the load. Splitting them would break the transactions that pair an approval with its audit row and the send re-check with the submission.
- **A tracking script, a CRM and an inbox integration.** Website visits come from seeded history; replies and meetings are logged by hand.

## What we would build next

- **Real authentication.** Sign-in through the company's identity provider instead of the user picker, sessions that expire, and roles managed by an admin. Roles are already enforced in the database, so only the sign-in layer changes.
- **Real models.** Tune the prompts on Claude, choose the model by quality and cost, track how often the guard rejects real output, and cap spend and latency per campaign.
- **Clearer mail provider errors.** Today every 4xx marks the card `failed`. Next: tell a bad address from rejected content or an account problem, say in plain words what to fix, and let the lead resend once it is fixed. A `returned` card should re-check the address and hold the person.
- **More than one send worker.** It needs a lease; today one worker holds the card's row lock during retries (marked `shortcut:`).
- **Data and compliance.** Live FX rates instead of seeded ones, erasure on request (delete the contact, keep only the opt-out hash), and Clay rows received by push, the way real Clay sends them.
