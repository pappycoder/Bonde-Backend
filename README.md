# Bonde Backend

The **Bonde API** — a single, professional REST backend serving both the **Bonde Admin dashboard** and the **Bonde mobile app**.

Built with **NestJS 12**, **TypeScript (strict)**, backed by **Supabase** for authentication, hosted **PostgreSQL (via Prisma)**, and **storage**, with **Redis** for caching and rate limiting.

## Stack

| Layer | Technology |
| --- | --- |
| Framework | NestJS 12 (Express, ESM) |
| Language | TypeScript (strict) |
| Auth | Supabase Auth (GoTrue REST BFF + JWT via JWKS) + RBAC |
| Database | Supabase PostgreSQL via Prisma |
| Storage | Supabase Storage |
| Cache / Rate-limit | Redis 7 |
| Validation | class-validator + Joi (env) |
| Docs | Swagger / OpenAPI |
| Testing | Vitest (unit + e2e) |
| Linting | oxlint + Prettier |
| Runtime | Node 22, Docker + docker-compose |

> **Note:** This scaffold is ESM-first and targets the NestJS 12 toolchain (Vitest for tests, oxlint for linting).

## Project structure

```
src/
  common/    shared infrastructure (redis, cache, throttling, errors, filters, http, swagger)
  modules/   business features, one directory per domain (auth, health, ...)
  config/    typed AppConfig + Joi env validation
  prisma/    Prisma service/module
```

## Getting started

### Prerequisites
- Node.js 22+
- pnpm 11+
- A Supabase project (or local via `supabase start`)
- Docker (for Redis + the local test Postgres)

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in the values — the app **fails fast at boot** if any required variable is missing or invalid (validated by a Joi schema).

### 3. Run

```bash
# Redis (via Docker)
docker compose up -d redis

# Development server (watch mode)
pnpm start:dev
```

The API is served at `http://localhost:3001`. Swagger / OpenAPI docs are available at `/api/docs` (UI) and `/api/docs-json` (OpenAPI 3 document) in non-production environments.

**Auth (BFF over Supabase):** registration and password recovery are brokered by
this API against Supabase Auth so clients never hold the service-role key.
See `POST /api/auth/register` → `POST /api/auth/verify-email` →
`POST /api/auth/login` (403 until verified), plus `/api/auth/refresh`,
`/api/auth/resend-verification-otp`, `/api/auth/forgot-password`,
`/api/auth/verify-reset-otp`, `PATCH /api/auth/reset-password`, and the
authenticated `GET /api/auth/me`. Email verification and password reset use
4-digit OTPs delivered via the `OTP_SENDER` provider.

## Environment variables

With `NODE_ENV=development`, `POST /api/cards` automatically creates or reuses
an inactive `Bonde Development` provider record if no active provider exists.
This supports local agent-card creation without a live issuer. These cards are
local records, not spendable provider-issued cards. Production and test retain
the active-provider requirement; `POST /api/cards/issued` has no fallback.

Authenticated owners can read their card number and stored CVV through
`GET /api/cards/:id/credentials`. This separate endpoint checks ownership, records
the access event without credential values, and sends `Cache-Control: no-store`.
Ordinary card/list responses continue to omit credentials. Development-only local
cards receive an encrypted development CVV on creation, or on the first credential
read for older local cards. Provider cards use their stored provider CVV; if it is
unavailable the endpoint returns `null`.

`PATCH /api/cards/:id/rules` saves an existing card's name, limits, budget
preferences, selected active lock (`lock: { id, config }`), and merchant/category
allowlists in one database transaction. It checks ownership and refuses cancelled
cards, preserves unrelated locks and usage counters, and records `rules.update`
with before/after values and currency for the history log. Optional `merchants`
replaces the merchant allowlist; optional `categories` replaces allowed categories
while preserving denied entries. The mobile Edit Rules page uses this endpoint.

Self-destruct lock reads include `config.usageCount`. If no recorded counter exists,
the API counts successful, approved card payments across the entire history for
the mobile `current/limit` display. This read does not mutate the lock.

`POST /api/cards/:id/cancel` destroys local cards or terminates provider-issued
cards through their issuer. `DELETE /api/cards/:id` only removes an owned card
after its status is `CANCELLED`. Both require zero remaining balance. Card
deletion retains transactions and approvals; transaction card references become
null, and the deletion is recorded in the audit log.

See [`.env.example`](./.env.example) for the full reference. Key variables:

| Variable | Required | Description |
| --- | :---: | --- |
| `NODE_ENV` | – | `development` \| `production` \| `test` |
| `PORT` | – | API port (default `3001`) |
| `CORS_ORIGINS` | – | Comma-separated allowed origins; empty blocks all CORS in production |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_ANON_KEY` | ✅ | Publishable anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Server-only key (bypasses RLS) |
| `DATABASE_URL` | ✅ | Pooled Postgres connection (runtime) |
| `DIRECT_URL` | ✅ | Direct Postgres connection (migrations) |
| `REDIS_URL` | – | Redis connection URI |
| `AUTH_TOKEN_SECRET` | ✅ | HS256 secret (≥32 chars) for short-lived registration/reset tickets |

## Scripts

| Command | Description |
| --- | --- |
| `pnpm start:dev` | Start in watch mode |
| `pnpm build` | Compile to `dist/` |
| `pnpm start:prod` | Run production build |
| `pnpm lint` | Lint with oxlint |
| `pnpm format` | Format with Prettier |
| `pnpm test` | Run unit tests |
| `pnpm test:e2e` | Run e2e tests (requires configured `.env` **and** `docker compose up -d redis postgres`) |
| `pnpm check` | Full quality gate: format + lint + tests + build |

## Docker

The `docker-compose.yml` runs the API, its Redis dependency, and a **local
Postgres** (`postgres` service, port `5433`, db/user/pass `bonde`) used by the
DB-backed e2e suites. Production PostgreSQL remains **managed by Supabase** —
point `DATABASE_URL` / `DIRECT_URL` at your Supabase database.

```bash
docker compose up -d          # redis + postgres (test deps)
docker compose up --build     # full stack
```

## Project structure

```
src/
├── main.ts                 # Bootstrap, global pipes, security headers
├── app.module.ts           # Root module
├── config/                 # Env validation (Joi) + typed configuration
└── ...                     # Feature modules (added per phase)
```

## Roadmap

- [x] Phase 1 — Core infrastructure (validation, security, logging, health)
- [x] Phase 2 — Database design (Prisma schema on Supabase Postgres)
- [x] Phase 3 — Auth (Supabase JWT verification + RBAC)
- [x] Phase 4 — Swagger / OpenAPI documentation
- [x] Phase 5 — Redis caching & rate limiting
- [x] Phase 6 — Storage (Supabase)
- [x] Phase 7 — Foundation + admin CRUD: profiles (incl. verified email), OTP/verification, notifications, audit trail, generic admin data-grid, and the **auth BFF** (register / verify-email / login / refresh / forgot + reset password)
- [ ] Phase 8 — Testing & delivery

## License

UNLICENSED — proprietary.


## Demo transaction history for mobile UI testing

Use an existing test account with a provisioned wallet. This development-only
helper writes 26 marked transaction records through Prisma; it does not call
payment providers, create approvals, send notifications, or update wallet
balances. It refuses to run with NODE_ENV=production. It uses DATABASE_URL from
the backend environment, so check that this is the intended development database.

```bash
# Preview first (no writes).
pnpm demo:transactions --email tester@example.com

# Seed. Stable IDs prevent duplicates on repeated runs.
pnpm demo:transactions --email tester@example.com --apply

# Optional: pin the fixture's most recent calendar day for reproducible dates.
pnpm demo:transactions --email tester@example.com --date 2026-10-20 --apply

# Preview cleanup, then remove only this account's tagged fixture IDs.
pnpm demo:transactions --email tester@example.com --remove
pnpm demo:transactions --email tester@example.com --remove --apply

pnpm test:demo-transactions
```

Refresh the Transactions tab after seeding. Examples cover multiple pages,
NGN/USD amounts, successful/pending/failed/declined states, deposits, withdrawals,
payments and transfers. Categories include Transport (TRAVEL), Bill & utilities
(ELECTRICITY), Dining, Health, Shopping and Groceries. The extended layouts have
matching metadata for payment reversal, BONDE Premium, AI credit purchase and
AI credit refund, including links to seeded original transactions.

Descriptions begin with [DEMO], and metadata.demoSeed identifies this fixture
set. Transaction-derived analytics will include these examples until cleanup;
wallet balances and card spending counters are not reconciled to this synthetic
history. Dates span the anchor day back through 62 days. Re-running preserves
existing fixture rows; remove and reseed to regenerate dates or edited examples.

### Profile hub and subscription billing

The mobile profile flow uses owner-scoped `/profile/preferences`, `/profile/support`,
`/profile/email-change` and `/profile/deletion-request` endpoints. Email changes use
Supabase's confirmation flow; `/profile/email-change/sync` reads the provider's
confirmed address rather than trusting stale JWT email claims. Deletion creates
an administrator-review support ticket after passcode verification and financial
prerequisite checks. It never deletes accounts or financial records directly.

Apply `20261021000200_profile_hub` using the normal migration deployment process
before deploying these endpoints. `/billing/catalog` is the authoritative price
source: Premium costs NGN 6,000/month and grants 8,000 monthly credits. Credit packs
are 10/NGN 5,000, 50/NGN 6,000, 60/NGN 6,500 and 70/NGN 7,000. Wallet debits,
transaction records, credit grants and purchase audits settle atomically. Orders
use permanent owner-scoped idempotency keys and can be reconciled or cancelled.

`PROFILE_BILLING_ENABLED` controls wallet purchases and the monthly renewal worker
(default `true`). Set it to `false` for maintenance or environments that should
not accept payments. The worker runs every minute; replicas share period keys and
profile row locks. It renews only previously paid wallet subscriptions with
recurring consent, preserves their accepted price, and stops renewal after
cancellation or insufficient funds. Manually granted legacy Premium does not
authorize a wallet debit. Annual billing and external-card checkout remain
unavailable. The existing AI agent integration is still unconfigured; this change
provides credit balances and grants, not an invented AI usage charging policy.

`TERMS_URL`, `PRIVACY_URL` and `SUBSCRIPTION_TERMS_URL` default to the approved
`https://www.usebonde.com` destination and can be configured individually.
