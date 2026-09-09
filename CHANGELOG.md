# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Database schema (Phase 2)**: Full Prisma schema for the Bonde domain.
  - 16 tables: `profiles`, `accounts`, `wallets`, `card_providers`, `cards`,
    `card_locks`, `card_categories`, `chats`, `messages`, `transactions`,
    `transaction_approvals`, `transaction_thresholds`, `notifications`,
    `otp_codes`, `biometric_devices`, `audit_logs`.
  - 14 enum types covering card/lock/transaction/notification/OTP/biometric state.
  - Decision notes: Supabase Auth (`auth.users`) is the identity source of truth
    and `profiles` extends it 1:1; card numbers encrypted at rest (AES-256-GCM);
    OTP codes stored SHA-256 hashed with 5-minute expiry; composable card locks
    (JSONB `config`); per-device biometric enrollment with public keys; account
    numbers bank-style with Luhn check digit; card balance synced from provider
    (display-only) while wallet balance is authoritative; per-user threshold
    warnings (`FIRST_TIME` / `LARGE_AMOUNT`).
- **Prisma 7 integration**: `@prisma/client` + driver adapter (`@prisma/adapter-pg`).
  - `prisma.config.ts` for the CLI (migrations use `DIRECT_URL`; loads `.env` via
    `dotenv/config` so `prisma generate`/`migrate` work without shell exports).
  - PrismaService (global provider) bound to the pooled `DATABASE_URL` via `PrismaPg`.
  - Initial migration `0001_init` generated offline (create-only).
  - `Dockerfile` build stage runs `prisma generate` (dummy `DIRECT_URL`; no `.env`
    in the image; only migrations need a real URL).
- **Updated scripts** in `package.json`: `prisma:generate`, `prisma:validate`,
  `prisma:migrate`, `prisma:deploy`, `prisma:studio`.
- **Auth (Phase 3)**: Supabase JWT verification + RBAC (verify-only — clients
  authenticate against Supabase Auth directly; the API never sees passwords or
  refresh tokens).
  - New `src/auth/` module: `JwksService` (ES256 verification via
    `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`, `jose` with a DI-provided
    key set), global `SupabaseAuthGuard` (Bearer token → `AuthPrincipal`),
    global `RolesGuard` (`SUPER_ADMIN > ADMIN > USER` from
    `app_metadata.role`, defaults USER).
  - Decorators: `@Public()` (health/root/catch-all stay public), `@Roles(...)`,
    `@CurrentUser()`.
  - `GET /api/auth/me` returns the verified principal.
  - Dependency: `jose` 6.
- **Schema**: `profiles.onboarding_completed_at` (migration
  `20260909171921_add_onboarding_completed_at`) — forward-preparation for the
  onboarding phase.
- **Swagger / OpenAPI (Phase 4)**: `@nestjs/swagger` 12 + `swagger-ui-express`.
  - Mounted at `/api/docs` (UI) and `/api/docs-json` (OpenAPI 3 document) in
    non-production via `configureSwagger` (`src/common/swagger.ts`); a no-op in
    production.
  - DocumentBuilder: *Bonde API*, version 0.1.0, `addBearerAuth('access-token')`
    scheme, server from `PUBLIC_URL`, Supabase-auth usage description.
  - Nest CLI swagger plugin enabled (`nest-cli.json`) for automatic DTO schema
    inference.
  - Annotations: `AuthController` (`@ApiTags('auth')`, bearer, `AuthPrincipalDto`
    model), `HealthController` (`@ApiTags('health')`, public), shared `ApiErrorDto`
    + `@ApiErrorResponse()` documenting the uniform error shape for 400/401/403/
    404/409/429/500/503, `AppController` excluded via `@ApiExcludeController()`.
- **Redis resilience**: rate limiting no longer takes the API down when Redis is
  unreachable.
  - `RedisThrottlerStorage` now **fails open**: a not-ready client or a failing
    command falls back to per-process `MemoryThrottlerStorage` (bounded,
    block-aware) with a one-time warning instead of throwing
    `MaxRetriesPerRequestError` → 500 on every request.
  - Redis client hardened: bounded `connectTimeout` (5s) + backoff
    (`min(times*200, 2000)`), log-once-per-outage with `ready`/`reconnecting`
    transitions.
  - `assertRedisUrl` fails the boot with a clear error when `REDIS_URL` uses the
    non-TLS `redis://` scheme against a `.upstash.io` host (Upstash requires
    `rediss://`).
  - `/api/health` returns the uniform **503** `ApiErrorDto` whose `message` lists
    the failing dependency (e.g. Redis) instead of a generic "Internal Server
    Error"; `/api/health/ready` remains 200 and Redis-independent.
  - Tests: 32 unit (memory storage, fail-open paths, TLS guard) + 12 e2e incl. a
    full Redis-outage suite (dead port): `/auth/me` still 401, `/health/ready`
    200, `/health` 503 — never 500.

### Changed

- `CommonModule` (catch-all) now imports **last** in `AppModule` so real feature
  routes (e.g. `/api/auth/me`) register before the wildcard.
- **Config/environment**:
  - Added `AppConfig.resend`, `AppConfig.termii`, `AppConfig.encryption` and Joi
    validation for `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `TERMII_API_KEY`,
    `TERMII_SENDER_ID`, `CARD_ENCRYPTION_KEY` (64-char hex).
  - Updated `.env.example` with the new third-party + encryption variables.

## [0.1.0] - 2026-09-09

### Added

- **Phase 0 — Scaffolding**:
  - NestJS 12 (ESM) project via `pnpm`.
  - `.editorconfig`, `.prettierrc`, `.prettierignore`, `.gitignore`, `.dockerignore`.
  - `@/*` path alias / tsconfig; strict TypeScript (`nodenext`, `strict`).
  - Typed configuration: `src/config/env.validation.ts` (Joi fail-fast) +
    `src/config/configuration.ts` (`AppConfig`) + `.env` / `.env.example`.
  - Multi-stage `Dockerfile` and `docker-compose.yml` (API + Redis; Postgres
    intentionally omitted — managed by Supabase).
  - `package.json` scripts incl. `check` quality gate; `README.md`; `AGENTS.md`.

- **Phase 1 — Core infrastructure**:
  - Security: `helmet`, `@nestjs/hpp` (HTTP parameter pollution), `set('trust proxy', 1)`,
    env-driven CORS.
  - Logging: `nestjs-pino` with `pino-http`; pino-pretty in dev, plain JSON in prod.
  - Global `ValidationPipe` (whitelist + forbidNonWhitelisted + transform).
  - Global exception filter producing a uniform JSON error shape
    `{ statusCode, error, message?, timestamp, path }` with no stack leaks.
  - Global rate limiting via `@nestjs/throttler` backed by a custom Redis
    throttler storage (keys `rate:{name}:{key}` / `rate:block:{name}:{key}`).
  - RedisModule (global `REDIS_CLIENT` token, ioredis) with graceful shutdown.
  - Health checks via `@nestjs/terminus` v12 (`/api/health`, `/api/health/ready`).
  - Catch-all controller (imported last) so unknown routes return the uniform
    JSON 404 instead of Express HTML.
- **Tests**: Vitest unit suite + e2e smoke suite (root, health, readiness, JSON 404).

### Fixed

- 404/405 responses returning raw Express HTML instead of the uniform JSON error
  shape (introduced the last-imported `CatchAllController`).
- ioredis type friction under `nodenext` via a minimal `RedisClient` interface.
- Health controller route prefix doubling (`/api/api/health`).