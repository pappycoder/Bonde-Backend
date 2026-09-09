# Bonde Backend

The **Bonde API** — a single, professional REST backend serving both the **Bonde Admin dashboard** and the **Bonde mobile app**.

Built with **NestJS 12**, **TypeScript (strict)**, backed by **Supabase** for authentication, hosted **PostgreSQL (via Prisma)**, and **storage**, with **Redis** for caching and rate limiting.

## Stack

| Layer | Technology |
| --- | --- |
| Framework | NestJS 12 (Express, ESM) |
| Language | TypeScript (strict) |
| Auth | Supabase Auth (JWT verified via JWKS) + RBAC |
| Database | Supabase PostgreSQL via Prisma |
| Storage | Supabase Storage |
| Cache / Rate-limit | Redis 7 |
| Validation | class-validator + Joi (env) |
| Docs | Swagger / OpenAPI |
| Testing | Vitest (unit + e2e) |
| Linting | oxlint + Prettier |
| Runtime | Node 22, Docker + docker-compose |

> **Note:** This scaffold is ESM-first and targets the NestJS 12 toolchain (Vitest for tests, oxlint for linting).

## Getting started

### Prerequisites
- Node.js 22+
- pnpm 11+
- A Supabase project (or local via `supabase start`)
- Docker (optional, for Redis / containerized API)

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

The API is served at `http://localhost:3001`. Swagger docs are available at `/api` in non-production environments.

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

## Scripts

| Command | Description |
| --- | --- |
| `pnpm start:dev` | Start in watch mode |
| `pnpm build` | Compile to `dist/` |
| `pnpm start:prod` | Run production build |
| `pnpm lint` | Lint with oxlint |
| `pnpm format` | Format with Prettier |
| `pnpm test` | Run unit tests |
| `pnpm test:e2e` | Run e2e tests (requires configured `.env`) |
| `pnpm check` | Full quality gate: format + lint + tests + build |

## Docker

The `docker-compose.yml` runs the API and its Redis dependency. PostgreSQL is **managed by Supabase** and is therefore not defined locally — point `DATABASE_URL` / `DIRECT_URL` at your Supabase database.

```bash
docker compose up --build
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

- [ ] Phase 1 — Core infrastructure (validation, security, logging, health)
- [ ] Phase 2 — Database design (Prisma schema on Supabase Postgres)
- [ ] Phase 3 — Auth (Supabase JWT verification + RBAC)
- [ ] Phase 4 — Swagger / OpenAPI documentation
- [ ] Phase 5 — Redis caching & rate limiting
- [ ] Phase 6 — Storage (Supabase)
- [ ] Phase 7 — Shared admin + mobile features
- [ ] Phase 8 — Testing & delivery

## License

UNLICENSED — proprietary.
