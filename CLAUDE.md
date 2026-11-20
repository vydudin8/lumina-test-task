# Lumina outbound (take-home, Project 2)

Company data from Clay, Apollo and FactSet → one company master → ICP fit score → postcard campaign through a fake print-and-mail API.

## Commands

- `pnpm dev` — app (3000), Vite (5173, proxies `/api`) and fake-world (4000). Needs Postgres and `.env` (copy `.env.example`).
- `pnpm seed:reset` — drop, migrate and seed the dev database.
- `pnpm test` — typecheck, ESLint, Prettier check, Vitest (unit + Postgres integration). `pnpm test:all` adds Playwright.
- `pnpm fixtures` — regenerate `fixtures/` (deterministic; the tests compare the committed files byte for byte).
- `pnpm db:generate` — Drizzle migration from `src/server/db/schema.ts`. Triggers and other hand-written SQL go in `drizzle-kit generate --custom` migrations.
- `docker compose up` — the whole stack; `docker compose --profile test run --rm test` — every test.

## Conventions

- All artifacts in English: code, comments, UI copy, commits.
- Node runs `.ts` directly (type stripping): imports carry the `.ts` extension, no enums or parameter properties. Subpath imports: `#server/*`, `#client/*`, `#common/*`, `#fake-world/*`.
- Tabs, single quotes, no semicolons (Prettier). Run `pnpm format` before committing.
- Tests first. Pure logic: `*.test.ts`. Anything touching Postgres: `*.db.test.ts`, which gets its own database cloned from a migrated template (`useTestDb()`).
- HTTP tests call `app.fetch` through `src/server/test/app.ts`.

## Rules that reviewers check

- Money and scores are `numeric` in Postgres and `decimal.js` in code. Never JS floats.
- Approvals, roles and audit are enforced in the database (CHECK, FK, triggers), not only in middleware.
- Every state change writes its `audit_events` row in the same transaction (`audit(tx, …)`).
- Every "now" goes through the injected clock. Every retry goes through `lib/retry.ts`.
- Contacts are personal data: never log names, emails or addresses (`log.ts` redacts them); the LLM gets first name, title and company facts only.
- `pipeline/*/core.ts` is pure (no DB, no HTTP); `store.ts` does the I/O.
