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
- `pnpm test:e2e` — Vitest e2e (requires configured `.env` **and**
  `docker compose up -d redis postgres`; DB suites run against local Postgres)
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

## Auth (BFF over Supabase + bearer verification)
- The API is a **BFF for Supabase Auth**: it brokers registration, email
  verification, login, refresh, and password recovery against the **GoTrue REST
  API** so mobile/dashboard clients never hold the service-role key. It stores
  no passwords or refresh tokens itself.
- Layout (`src/modules/auth/`):
  - `guards/` + `decorators/` + `principal/`: global `SupabaseAuthGuard`
    (Bearer → `AuthPrincipal` via remote JWKS) + `RolesGuard`
    (`SUPER_ADMIN > ADMIN > USER` from `app_metadata.role`; absent → `USER`).
    Import the shared contract from `modules/auth/decorators/`
    (`@Public()`, `@Roles(...)`, `@CurrentUser()`, `AuthPrincipal`) — also from
    `common/` and other features (intentional).
  - `supabase/` (`supabase-auth.client.ts`): `SupabaseAuthGateway` +
    `SupabaseAuthClient` (factory-injected via the `SUPABASE_AUTH_BODY` token so
    e2e can swap a fake; GoTrue calls carry a 10s timeout) + `AuthProviderError`
    with codes `USER_EXISTS`, `INVALID_CREDENTIALS`, `EMAIL_NOT_CONFIRMED`,
    `NOT_FOUND`, `PROVIDER`.
  - `services/` (`auth.service.ts`, `auth-tokens.service.ts`): orchestration +
    short-lived HS256 `registration`/`reset` tickets (`AUTH_TOKEN_SECRET`,
    Redis nonce `auth:nonce:{purpose}:{jti}`). The `verify*` helpers only check
    the nonce; `consume*` revokes it — **always consume AFTER the protected
    step succeeds** so a wrong code never burns the ticket.
- Auth routes are `@Public()` + `@StrictThrottle()`: `POST /api/auth/register`
  (201 → `{ status, registrationToken }`), `POST /api/auth/verify-email`, `POST
  /api/auth/resend-verification-otp`, `POST /api/auth/login`, `POST
  /api/auth/refresh`, `POST /api/auth/forgot-password`, `POST
  /api/auth/verify-reset-otp`, `PATCH /api/auth/reset-password`. `GET
  /api/auth/me` stays authenticated.
- **Login requires email verification**: registration creates an
  `email_confirm:false` user (service-role `createUser`) and `login` returns
  403 until `verify-email` succeeds. `forgot-password` always answers 200 — no
  user enumeration. Emails are normalized to lowercase.
- New authenticated routes are protected by default; opt out with `@Public()`.
  Roles are assigned in Supabase (dashboard / edge function), never in
  PostgreSQL.

## Profiles, OTP & verification
- **Profiles**: `profiles` mirrors Supabase `auth.users` 1:1 — including the
  verified `email` (`VARCHAR(254)`, unique, provisioned at registration) — and
  is provisioned by the auth flow, never created ad-hoc. Users mutate their own
  row through `GET/PATCH /api/profile` (`src/modules/profiles/`). `phone` is
  unique (409 on conflict); changing it resets `phoneVerified`.
  `onboardingCompleted: true` stamps `onboardingCompletedAt`. Avatar paths must
  be under `u-<userId>/`; URLs come from
  `StorageService.getPublicUrl('bonde-avatars', path)` — the API never proxies
  bytes.
- **OTP**: codes are **4-digit** (`OTP_CODE_LENGTH = 4`), stored as **SHA-256
  digests** (never plaintext), 5-min TTL, single-use; sending a new code
  invalidates earlier ones. `OtpService` exposes principal-free primitives
  `generateCode(userId, channel)` (returns the plaintext), `consumeCode(userId,
  channel, code)` (boolean) and `invalidate(userId, channel)`; the `send` /
  `verify` self-service endpoints wrap them. Targets must be the caller's own
  email (EMAIL) or principal/profile phone (PHONE). Delivery crosses the
  `OTP_SENDER` token (`src/modules/otp/otp-sender.interface.ts`) — production
  backs it with `RoutingOtpSender` (Termii SMS / Resend email). **Fail
  closed**: a `OtpSendError` becomes a 503 *and* the just-created code is
  voided.
- **Throttling**: `send`/`verify` are stamped `@StrictThrottle()` (strict
  throttle, env-tuned). The response never includes the code; tests capture it
  by overriding the `OTP_SENDER` provider.

## Admin CRUD (registry-driven data-grid)
- `src/modules/crud/` exposes `POST/GET/PATCH/DELETE /api/admin/:resource[/:id]`
  — admin mutates most tables through a generic, field-safe layer. The **source
  of truth is the registry** (`crud.registry.ts`): each resource declares its
  field `kind` (`uuid|string|int|decimal|boolean|enum|json|datetime`),
  required/writable/visible sets, and allowed methods (it asserts invariants at
  boot). `CrudService` coerces/validates payloads and maps Prisma errors to the
  uniform contract (P2002→409, P2025→404, P2003/P2011/P2012→400).
- Query contract: `?page&pageSize` (pageSize ≤ 100), `filter=field:value`
  (equality, on visible fields only), `orderBy=field:asc|desc`. Responses are
  `{ items, total, page, pageSize, totalPages }`; responses/rows are projected
  to **visible** fields and Date/Decimal are serialized (ISO / string).
- **Exclusions are deliberate**: `profiles`, `accounts`, `wallets`, `cards`,
  `transactions`, `transaction_approvals`, `otp_codes` are NOT in the registry
  — they stay on dedicated, hardened flows. `card-providers.config` (API
  secrets) is absent from the registry so it is never written to or read back.
  `audit-logs` is read-only (POST/PATCH/DELETE → 405 `MethodNotAllowedException`).
- Controller is `@Roles('ADMIN','SUPER_ADMIN')` (`@Controller('admin')`); the
  route prefix is `/api/admin` under the global `api` prefix. Every write is
  audited (`admin.crud.create/update/delete`) via `AuditLogService.record`.
- Every model uses `String @id` with **no default** — creates must supply
  `randomUUID()` client-side (CrudService/NotificationsService/OtpService/
  AuditLogService all do).

## Self-service user data surface
- Authenticated (USER+) endpoints under the `api` prefix scope **every** read
  and write to `principal.userId`; anything not owned resolves to a uniform 404
  (`NotificationsService.markRead` pattern) — never 403 — so existence is not
  leaked. Modules: `accounts/`, `wallets/`, `cards/`, `chats/`,
  `transactions/` (transactions + approvals), `thresholds/`, `biometrics/`.
- **Accounts & wallets are 1:1**: `Account.userId` is `@unique` (migration
  `20260910130000_add_account_user_unique`), so a user holds exactly one
  account and, via unique `Wallet.accountId`, one wallet. They are provisioned
  by other services, but the self-service surface exposes **full CRUD** so those
  services can drive them: `GET/POST/PATCH/DELETE /api/account` (POST `201`,
  409 on unique `userId`/`accountNumber`; omitted `accountNumber` gets a
  Luhn-valid 10-digit one from `accounts/account-number.ts`; DELETE cascades
  the 1:1 wallet) and `GET/POST/PATCH/DELETE /api/wallet` (POST 404s until the
  caller's account exists at `wallet.accountId`, 409 duplicate;
  DELETE 400 if transactions still reference it). `PATCH /api/wallet` is where
  money-movement reconciles `balance`.
- **Cards**: `GET /api/cards[/:id]` never returns `cardNumberEncrypted` (only
  `cardNumberLast4`); provisioning is internal/provider-owned so there is no
  user `POST`. Users manage lifecycle (`PATCH .../pause|resume` — 400 if
  `CANCELLED`, `PATCH .../limit`) and the composable locks / restricted
  categories nested under `/api/cards/:id/locks` and `.../categories`
  (unique `cardId+lockType` / `cardId+category` → 409).
- **Transactions & approvals expose full CRUD** for provisioning services:
  `GET/POST/PATCH/DELETE /api/transactions` (POST resolves `walletId` →
  `wallet.account.userId` and `cardId`/`chatId` ownership → 404; P2003 → 400),
  `GET /api/transactions/recent?limit=` (≤50, declared before `:id`),
  `GET/POST/PATCH/DELETE /api/approvals` (POST `approvedBy` is always the
  caller, never client-supplied; the owning transaction must be the caller's).
  **Transaction writes never touch `wallet.balance`** — reconciliation happens
  through `PATCH /api/wallet`. Thresholds are user-CRUD (`/api/thresholds`,
  unique `userId+thresholdType` → 409).
- **Chats**: `/api/chats` history + CRUD; `/api/chats/:id/messages` lists
  chronologically (secondary `id` sort makes seeded `createdAt` ties
  deterministic) and `POST` appends only `USER`-role messages (assistant
  replies come from the AI pipeline).
- **Biometrics**: `/api/biometric-devices` CRUD stores only the verification
  `publicKey`; `unique(userId, deviceId)` → 409. **Audit**: `GET
  /api/audit-logs[/:id]` shows only the caller's entries and is read-only
  (admin-wide list remains `/api/admin/audit-logs`).
- List endpoints use the `{ items, total, page, pageSize, totalPages }`
  envelope (pageSize ≤ 100, default 20); `recent` and nested locks/categories
  return plain bounded arrays. **Every `Decimal` money field serializes to a
  fixed 2-decimal string** (`"2500.00"`) via `src/common/money/money.ts`
  (`money()` = `Decimal`.toFixed(2)) — applied in the feature services and the
  admin `CrudService`. Writes are audited via `AuditLogService.record`
  (`account.create|update|delete`, `wallet.create|update|delete`,
  `transaction.create|update|delete`, `approval.create|update|delete`,
  `card.pause|resume|limit|lock.*|category.*`, `chat.*[.message]*`,
  `threshold.*`, `biometric.*`).

## Database & testing
- Runtime DB is Supabase Postgres (`DATABASE_URL` pooled, `DIRECT_URL` direct)
  via the `PrismaPg` driver adapter. **e2e DB suites instead run against a local
  dockerized Postgres** (`postgres` service in `docker-compose.yml`, port
  `5433`, `postgresql://bonde:bonde@localhost:5433/bonde`) — runtime env is
  untouched.
- `test/db.ts` owns the constants + fixtures: seeded profiles use **real UUIDs**
  (`SEED_USER_ID` etc.) because `profiles.id` is `@db.Uuid`; `truncateAll`
  TRUNCATEs the 16 tables CASCADE; `seedBaseFixtures` upserts the profile/
  provider/card/chat baseline **plus** an account+wallet (SEED_USER only — the
  SEED_OTHER user intentionally has none, powering 1:1 ownership 404s),
  chat messages, a PENDING transaction + approval, a threshold, a
  notification, and a biometric device for SEED_USER.
- Vitest global setup (`test/global-setup.ts`, configured via
  `vitest.config.e2e.ts` → `globalSetup`) applies `prisma migrate deploy` with
  `DATABASE_URL`/`DIRECT_URL` pointed at local Postgres and seeds fixtures;
  its `teardown` export truncates all tables. **Vitest 4 has no `globalTeardown`
  config option** — use the named `setup`/`teardown` exports.
- `test/e2e-app.ts` boots the full `AppModule` with the local DB env,
  `ValidationPipe` parity with `main.ts`, a mockable `JwksService.verify`, an
  authed `supertest` client (`ctx.http` injects a Bearer token; `ctx.raw` is
  the bare client), and optional `overrideProvider` hooks (`BootE2EOptions.overrides`).
- **Serial execution matters**: e2e files trunctate + reseed the SAME local
  Postgres, so `vitest.config.e2e.ts` sets `fileParallelism: false`.
- **Redis interplay**: throttler counters live in Redis. Suites pin **dedicated
  Redis DBs** (`:6379/12` rate-limit scratch, `/13` smoke, `/14` 429-proof,
  `/15` OTP, `/16` auth) with env overrides restored in `afterAll`, and
  `test/global-setup.ts` flushes `0,12,13,14,15,16` so counters never leak
  between runs. `bootE2EApp` awaits Redis `ready` before returning so every
  request of a suite counts on ONE store — a burst straddling the fail-open
  memory→Redis switch would otherwise split counters and 429/under-count
  non-deterministically.
- **Throttle semantics**: both `RedisThrottlerStorage` and the memory fallback
  block a key only when its count **EXCEEDS** the `limit` (`count > limit`) —
  hitting exactly `limit` is allowed — matching `@nestjs/throttler` ("blocked
  if it exceeds"). The default throttler blocks only while
  `THROTTLE_BLOCK_DURATION > 0`; the rate-limit e2e sets it explicitly (limit 3
  ⇒ requests 1–3 pass, #4 is 429).

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
    auth/          Supabase BFF + JWT verification + RBAC (global APP_GUARDs;
                   supabase/ gateway client, services/ orchestration + tickets)
    health/        terminus health/readiness probes
    profiles/      self-service profile (GET/PATCH /profile, avatar)
    otp/           app-level phone/email verification (send/verify)
    notifications/ mobile notification feed (list/read/read-all)
    audit/         append-only AuditLogService.record + self-service audit-logs
    crud/          generic admin data-grid (registry + /admin/:resource)
    accounts/      single account (CRUD /account, 1:1 via unique Account.userId)
    wallets/       single wallet (CRUD /wallet)
    cards/         cards (list/detail, pause/resume/limit, locks, categories)
    chats/         chat history + messages (+USER message append)
    transactions/  transactions + approvals CRUD
    thresholds/    user transaction thresholds (CRUD)
    biometrics/    enrolled biometric devices (CRUD)
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
`pnpm test:e2e` requires Redis **and** local Postgres running (`docker compose up -d redis postgres`); e2e suites never use SaaS secrets (Redis throttling counters use the shared Docker Redis; DB suites use the local Postgres).
