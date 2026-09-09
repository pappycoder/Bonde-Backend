# AGENTS.md — Bonde Backend

Guidance for AI agents and contributors working in this repository.

## Project overview
A NestJS 12 (ESM) REST API serving both the Bonde admin dashboard and mobile app. Supabase provides auth, hosted PostgreSQL (via Prisma), and storage; Redis provides caching and rate limiting.

## Commands
- `pnpm start:dev` — watch-mode dev server
- `pnpm build` — compile to `dist/`
- `pnpm lint` — oxlint (fast, type-aware)
- `pnpm format` / `pnpm format:check` — Prettier
- `pnpm test` — Vitest unit tests
- `pnpm test:e2e` — Vitest e2e (requires configured `.env`)
- `pnpm check` — full quality gate (format + lint + unit + e2e + build)
- `pnpm prisma:generate` — generate Prisma client
- `pnpm prisma:validate` — validate `prisma/schema.prisma`
- `pnpm prisma:migrate` — `prisma migrate dev` (needs `DIRECT_URL`)
- `pnpm prisma:deploy` — apply migrations in CI/prod (`prisma migrate deploy`)

## Database (Prisma 7)
- Schema lives in `prisma/schema.prisma` (16 tables, datasource has NO `url`).
- CLI connection config lives in `prisma.config.ts` — Migrate uses `DIRECT_URL`;
  the app runtime uses pooled `DATABASE_URL` via the `@prisma/adapter-pg`
  (`PrismaPg`) driver adapter inside `src/prisma/prisma.service.ts`.
- After editing the schema: `pnpm prisma:generate` then `pnpm prisma:validate`.
- Schema uses snake_case mapped columns (`@map`), UUID ids, `Decimal(15,2)` money.
- Card numbers are encrypted at rest (AES-256-GCM, see `CARD_ENCRYPTION_KEY`);
  never store or log plaintext card numbers.
- OTP codes are stored SHA-256 hashed (`otp_codes.code` holds the digest).

## Auth (verify-only)
- Clients authenticate against **Supabase Auth directly**; the API never builds
  its own auth. `SupabaseAuthGuard` + `RolesGuard` are global `APP_GUARD`s.
- New authenticated routes are protected by default. Opt out with `@Public()`
  (already applied to health, root, and the 404 catch-all).
- Enforce roles with `@Roles('ADMIN', ...)`; hierarchy `SUPER_ADMIN > ADMIN > USER`,
  read from the access token's `app_metadata.role` (absent → `USER`). Roles are
  assigned in Supabase (dashboard / edge function), not in PostgreSQL.
- `src/modules/auth/` exports `@CurrentUser()`, `@Roles(...)`, `@Public()`, and
  `AuthPrincipal`. Use `@CurrentUser()` to get the verified principal (auth
  decorators are a shared contract — importing them from `common/` or other
  modules is intentional).
- Password recovery emails are sent by **Supabase Auth** (its own SMTP
  integration) — do not build a recovery endpoint. Our `otp_codes`
  table + Resend/Termii keys are for app-level flows (e.g. phone
  verification), which are a later phase.

## Swagger / OpenAPI docs
- Mounted by `configureSwagger` in `src/common/swagger.ts` at `/api/docs` (UI)
  and `/api/docs-json` (OpenAPI 3). It is a **no-op in `production`** — docs are
  a development convenience only and must never be exposed publicly.
- The Nest CLI swagger plugin is enabled in `nest-cli.json` (auto-infers DTO
  schemas); add explicit `@ApiProperty` metadata only for unions, nullable/
  enum fields, and example values.
- Annotate every controller with `@ApiTags`. Protected routes get
  `@ApiBearerAuth('access-token')`; add `@ApiOperation({ summary })` and a
  typed `@ApiOkResponse({ type })` (use a real DTO class as the response model,
  e.g. `AuthPrincipalDto`).
- Document errors with the shared `@ApiErrorResponse()` decorator (declares the
  uniform `ApiErrorDto` shape for 400/401/403/404/409/500 emitted by
  `HttpExceptionFilter`). Do not leak 5xx internals into schemas.
- Exclude non-API helpers (e.g. the root hello controller) with
  `@ApiExcludeController()`.

## Conventions
- **ESM only.** All relative imports include the `.js` extension (NestJS 12 `nodenext` resolution). Do not import without the file extension.
- TypeScript **strict**. Avoid `any` except where oxlint explicitly allows it (`no-explicit-any` is off).

## Module structure
```
src/
  common/    shared, cross-cutting infrastructure (no feature logic)
    redis/       global ioredis connection + client interface
    cache/       CacheService / CacheModule
    throttling/  {redis|memory}-throttler.storage + @StrictThrottle()
    errors/      ApiErrorDto + @ApiErrorResponse()
    filters/     global HttpExceptionFilter
    http/        API-wide controllers (404 catch-all)
    storage/     StorageService + signed-URL endpoints
    swagger.ts   configureSwagger bootstrap helper
  modules/   one directory per business domain
    <feature>/
      <feature>.module.ts, <feature>.controller.ts        (home-grown structure)
      principal/   cross-cutting types/DTOs shared within the feature
      guards/      feature guards
      decorators/  param/method/class decorators
      services/    feature services
    auth/          Supabase JWT verification + RBAC (global APP_GUARDs)
    health/        terminus health/readiness probes
  config/   typed AppConfig (configuration.ts + Joi env.validation.ts)
  prisma/   PrismaModule + PrismaService (pg driver adapter)
```
- Feature modules own a domain end-to-end; keep subfolders only once a category
  has more than a couple of files. New features live under `src/modules/`.
- Specs are colocated next to their source (`*.spec.ts`).
- `common/` never imports feature internals, except the shared auth decorator
  contract from `modules/auth/decorators/` (e.g. `@Public()` on the catch-all).
- Direct relative imports only (`.js` suffix); no index barrels, no `@/` alias.

## Redis & resilience
- The global `RedisClient` (`src/common/redis/`) is the single ioredis connection.
  TLS-only providers (e.g. Upstash) require `rediss://` in `REDIS_URL`;
  `assertRedisUrl` fails the build fast on a `redis://` URL against `.upstash.io`.
- Rate limiting (`RedisThrottlerStorage`) is **fail-open**: if Redis is down or
  not ready, it degrades to per-process `MemoryThrottlerStorage` and logs a
  warning — the API never 5xxes because of a rate-limit store outage.
- `/api/health` reports `503` (uniform `ApiErrorDto`, message lists the failing
  dependency) when a dependency is down; `/api/health/ready` stays `200`.
- Do not reintroduce `enableOfflineQueue: false` — commands issued before the
  first connect would fail outright; keep bounded `maxRetriesPerRequest` +
  `retryStrategy` and rely on the throttler fallback instead.

## Caching & rate limiting
- Use `CacheService` (`src/common/cache/`) for cache-aside data: `get<T>`,
  `set`, `del`, `invalidate('pattern:*')` (SCAN-based) and single-flight
  `getOrSet(key, ttlMs, loader)`. Keys are prefixed `cache:`. Fail-open: a Redis
  outage yields cache misses (source is read) — never an error.
- Rate limiting: the `default` throttler is env-driven and applies to every
  route. Security-sensitive endpoints (OTP send/verify, etc.) must additionally
  be stamped `@StrictThrottle()` (`src/common/throttling/`), which applies the
  `strict` throttle (5/min with 5-min lockout by default, env-tuned). Existing
  endpoints are unaffected because the strict throttle is `skipIf`-ignored
  unless marked.
- Prefer `@nestjs/throttler` names/decorators over hand-rolled limits.
- Do not access `process.env` directly in feature modules — use the typed config (`ConfigService` with `AppConfig`) defined in `src/config/`.
- Never commit `.env`, secrets, or the Supabase service-role key.
- The Supabase service-role key is **server-only** and must never reach a client.

## Storage (Supabase)
- `StorageService` (`src/common/storage/`) mediates the Supabase Storage REST
  API with the **service-role key** (server-only — never returned or logged).
  It is a `@Global()` module; any feature module can inject it.
- Buckets are a fixed catalog in `storage.types.ts`: `bonde-avatars` (public),
  `bonde-kyc-docs` and `bonde-chat-files` (private). Unknown buckets, unsafe
  paths (leading `/`, `..`, spaces), disallowed content types, and oversized
  declarations are rejected before any HTTP call leaves the server.
- Mobile uploads use signed URLs (`POST /api/storage/upload-url` → PUT URL +
  `content-type` header); reads use `GET /api/storage/signed-url`. The API
  never proxies file bytes; per-bucket `expiresIn` bounds live in
  `storage.types.ts`.
- Storage is a write-path dependency: on outage, upload/sign calls fail closed
  with a uniform `503` (`ServiceUnavailableException`) rather than pretending
  the write succeeded.

## Verification
Run `pnpm check` before finishing. If e2e fails due to missing Supabase credentials, note the requirement rather than disabling the test.
`pnpm test:e2e` also requires Redis running (`docker compose up -d redis`).
