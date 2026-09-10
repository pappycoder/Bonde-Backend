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
