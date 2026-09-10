# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **User card creation, patching, change history, and merchant allowlist**:
  - `POST /api/cards` creates a **virtual** card (nickname, `maxSpendLimit`/
    `monthlyLimit` as fixed 2-decimal strings, `expirationType` `monthly`|
    `yearly`, derived `expirationDate`). The server generates a Luhn-valid
    16-digit PAN, AES-256-GCM encrypts it (`src/common/crypto/aes-gcm.ts`;
    `enc::iv::tag::cipher` payloads) and stores only `cardNumberEncrypted` +
    plaintext `cardNumberLast4` — the PAN is never returned. Provider is the
    first active `CardProvider` (503/404 if none).
  - `PATCH /api/cards/:id` updates nickname / card type / limits (money
    normalized on write) and records a `card.update` history diff; the existing
    `PATCH .../limit` stays as a thin alias.
  - **`card_history` table** (migration `20260910165003`): every card mutation
    (create, update, pause, resume, limit, `lock.*`, `category.*`,
    `merchant.add|remove`) appends a timeline row; `GET /api/cards/:id/history`
    lists it newest first (owned-404).
  - **Merchant allowlist**: `GET/POST/DELETE /api/cards/:id/merchants` — a card
    may only be used to purchase from the listed merchants (deny-by-default;
    enforcement belongs to the provider/purchase flow). `card_merchants` holds
    `merchantName` + optional `merchantCode` (`@@unique([cardId, merchantCode])`,
    name dedupe when code absent → 409). Audited `card.merchant.add|remove`.
  - Tests: 5 new unit cases in `aes-gcm.spec.ts` (round-trip, fresh IV, bad-key/
    malformed payload) + card create/update/history/merchant unit coverage
    (Luhn PAN, encryption prefix, money normalization, before/after diffs, 409s)
    and e2e (create-PAN-never-exposed, patch diffs, history ordering, merchant
    add/dedupe/remove, foreign 404s).
  - Docs: AGENTS.md cards + audit-action bullets updated.

- **Eager provisioning on registration + `AccountType` enum**:
  - Email verification is now the registration-completion step: `verify-email`
    marks the profile verified **and** provisions the user's single checking
    account (Luhn account number) + zero-balance wallet in one
    `prisma.$transaction` (`AuthService.provisionAfterVerification`), so account
    + wallet exist immediately once registration goes through — never left to a
    later onboarding call. A `P2002` race resolves to "already provisioned"
    (idempotent), and the registration token is consumed last so a provisioning
    failure rolls back and the user can retry. `account.create` / `wallet.create`
    audit entries are recorded alongside `auth.email_verified`.
  - `Account.accountType` is a **Prisma enum `AccountType`
    (`CHECKING` | `SAVINGS` | `BUSINESS`)** instead of a free string
    (migration `20260910150000_account_type_enum` uppercases + casts existing
    rows). `POST/PATCH /api/account` validate with `@IsEnum` — lowercase
    `"checking"`/`"savings"` bodies now 400; send `"CHECKING"`/`"SAVINGS"`.
  - Tests: auth service unit coverage for atomic/no-reprovision provisioning;
    auth e2e asserts no account pre-verification and a provisioned
    Luhn-checking account + NGN wallet right after `verify-email`.

- **Foundation + Admin CRUD (Phase 7)**: Profiles/OTP/Notifications/Audit +
  generic admin data-grid.
  - **Profiles self-service** (`src/modules/profiles/`): `GET/PATCH
    /api/profile`, `PATCH /api/profile/avatar`. A profile is a 1:1 mirror of
    Supabase `auth.users` and is provisioned by the auth flow — never ad-hoc.
    Updating `phone` (a unique key) resets `phoneVerified` (409 on conflict);
    `onboardingCompleted: true` stamps `onboardingCompletedAt`; avatar paths
    must live under `u-<userId>/` and resolve to stable public URLs via
    `StorageService.getPublicUrl('bonde-avatars', path)`.
  - **OTP / verification** (`src/modules/otp/`): `POST /api/otp/send`,
    `POST /api/otp/verify` — app-level proof-of-control. **4-digit** codes
    (`OTP_CODE_LENGTH = 4`; `OtpService` exposes the principal-free primitives
    `generateCode` / `consumeCode` / `invalidate`), stored as **SHA-256 digests**
    (never plaintext), 5-minute TTL, single-use, and sending a new code
    invalidates earlier ones. Delivery goes through the `OTP_SENDER` boundary
    (`RoutingOtpSender` → Termii SMS / Resend email via `fetch`) and **fails
    closed**: a delivery failure is a 503 *and* voids the just-created code.
    Targets are restricted to the caller's own email (EMAIL) or the
    principal/profile phone (PHONE). Both routes carry `@StrictThrottle()`
    (5/min with 5-min lockout by default).
  - **Notifications** (`src/modules/notifications/`): mobile-facing
    `GET /api/notifications` (paged, `status` filter), `PATCH
    /api/notifications/:id/read`, `PATCH /api/notifications/read-all`; the
    internal `NotificationsService.create` is the single write path (admin
    listing lives under generic CRUD).
  - **Audit trail** (`src/modules/audit/`): append-only `AuditLogService.record`
    ({userId, action, entityType, entityId, metadata?, ipAddress?,
    userAgent?}) wired into profile changes (`profile.update`,
    `profile.avatar`) and every admin CRUD write (`admin.crud.create/update/
    delete`). Reads are served exclusively via the read-only `audit-logs`
    CRUD resource.
  - **Generic Admin CRUD** (`src/modules/crud/`): registry-driven REST for the
    admin dashboard over `card-locks`, `card-categories`, `chats`, `messages`,
    `transaction-thresholds`, `biometric-devices`, `notifications`,
    `card-providers`, and `audit-logs` (read-only). `@Roles('ADMIN',
    'SUPER_ADMIN')`-protected under `/api/admin/:resource[:/:id]`, with:
    required/unknown/non-writable field enforcement, per-kind coercion
    (uuid/string/int/decimal/boolean/enum/json/datetime), Prisma error mapping
    (409/404/400), projection to `visible` fields only, and paginated +
    filterable + sortable lists (`?page&pageSize&filter=field:value&orderBy=
    field:asc|desc`, pageSize capped at 100). **Excluded from generic writes/
    deletes by design**: `profiles`, `accounts`, `wallets`, `cards`,
    `transactions`, `transaction_approvals`, `otp_codes` — these stay on
    dedicated, hardened flows. `card-providers.config` (API secrets) is absent
    from the registry so it is never written or read back through the API;
    `audit-logs` rejects writes with 405.
  - **E2E database foundation**: `docker-compose` `postgres` service (port
    5433, `bonde`/`bonde`/`bonde`); Vitest global setup applies `prisma
    migrate deploy` + seeds fixtures; global teardown truncates all tables. New
    DB-backed suites under `test/` (`crud`, `profiles`, `otp`, `notifications`,
    `audit`) boot the full `AppModule` against the local Postgres with a
    mockable JWKS verifier and an authed `supertest` client.
  - Tests: Phase 7 adds ~50 unit + 46 e2e cases (incl. 403/405/409/429/503
    paths, audit redaction, secret never returning `card-providers.config`).

- **Auth BFF over Supabase (Phase 7)**: registration, email verification,
  login/refresh, and password recovery brokered against the **GoTrue REST API**
  (`src/modules/auth/supabase/supabase-auth.client.ts`), extending Phase 3's
  verify-only posture into a full BFF — the API never stores passwords or
  refresh tokens, and clients never touch the service-role key.
  - Routes (all `@Public()` + `@StrictThrottle()`): `POST /api/auth/register`
    (201 → `{ status: 'pending', registrationToken }`), `POST
    /api/auth/verify-email`, `POST /api/auth/resend-verification-otp`, `POST
    /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/forgot-password`,
    `POST /api/auth/verify-reset-otp`, `PATCH /api/auth/reset-password`;
    `GET /api/auth/me` unchanged.
  - **Signup gate**: registration creates an `email_confirm:false` user (admin
    `createUser`) and provisions `profiles` (with the new unique
    `profiles.email`) — login is `403` until email verification completes.
  - Email verification / password reset use the existing **4-digit OTP**
    machinery; the protected step is wrapped in a short-lived **HS256
    registration/reset ticket** (`AUTH_TOKEN_SECRET`, one-time Redis nonce) so a
    wrong code is rejected without burning the ticket (`verify*` checks,
    `consume*` revokes; consume only after success). Forgot-password never
    reveals which emails exist (no enumeration).
  - Provider errors map via `AuthProviderError`
    (`USER_EXISTS`/`INVALID_CREDENTIALS`/`EMAIL_NOT_CONFIRMED`/`NOT_FOUND`/
    `PROVIDER`) to 409/401/403/404/503; downstream failures fail closed.
  - Tests: `auth.service.spec.ts` unit suite (register/verify/login/refresh/
    forgot/reset, error mapping, fail-closed delivery, email normalization) and
    a 9-scenario `test/auth.e2e-spec.ts` against a fake Supabase gateway.
  - Docs: AGENTS.md `## Auth (BFF over Supabase + bearer verification)`.

- **Self-service user data surface**: user-scoped CRUD/read endpoints across
  the remaining domain models (all `@CurrentUser()`-scoped; anything not owned
  is a uniform 404).
  - **Accounts & wallets are 1:1**: `Account.userId` is now `@unique`
    (migration `20260910130000_add_account_user_unique`), so a user holds one
    account and one wallet. **Full CRUD** is exposed so provisioning services
    can drive them: `GET/POST/PATCH/DELETE /api/account` (POST `201`; 409 on
    unique `userId`/`accountNumber`; a Luhn-valid 10-digit `accountNumber` is
    generated when omitted; DELETE cascades the 1:1 wallet) and
    `GET/POST/PATCH/DELETE /api/wallet` (POST 404 until the caller's account
    exists, 409 duplicate; DELETE 400 while transactions still reference it).
  - **Cards** (`src/modules/cards/`): `GET /api/cards[/:id]` (PAN never
    returned — `cardNumberLast4` only), `PATCH /:id/pause|resume` (400 if
    `CANCELLED`), `PATCH /:id/limit`, plus nested composable locks and
    restricted categories under `/:id/locks` and `/:id/categories`
    (unique `cardId+lockType` / `cardId+category` → 409). Provisioning is
    internal/provider-owned, so there is still no user `POST`.
  - **Chats** (`src/modules/chats/`): `GET/POST /api/chats`, `GET/PATCH/DELETE
    /api/chats/:id`, `GET /api/chats/:id/messages` (chronological, secondary
    `id` sort for tied `createdAt`) and `POST .../messages` (USER-role only;
    assistant replies remain out of scope).
  - **Transactions + approvals expose full CRUD** (`src/modules/transactions/`):
    `GET/POST/PATCH/DELETE /api/transactions` (POST resolves `walletId` →
    `wallet.account.userId` and `cardId`/`chatId` ownership; P2003 → 400),
    `GET /api/transactions/recent?limit=`, `GET /api/transactions/:id`,
    `GET/POST/PATCH/DELETE /api/approvals` (POST locks `approvedBy` to the
    caller; the owning transaction must be the caller's). **Transaction writes
    never touch `wallet.balance`** — reconciliation happens via
    `PATCH /api/wallet`.
  - **Thresholds** (`src/modules/thresholds/`): user CRUD at `/api/thresholds`
    (unique `userId+thresholdType` → 409). **Biometrics**
    (`src/modules/biometrics/`): CRUD at `/api/biometric-devices` storing only
    the verification `publicKey` (`unique(userId, deviceId)` → 409).
  - **Audit self-service**: `GET /api/audit-logs[/:id]` in the existing audit
    module — read-only, caller's entries only (admin-wide remains
    `/api/admin/audit-logs`). Writes in all modules are audited
    (`account.*`, `wallet.*`, `transaction.*`, `approval.*`, `card.*`,
    `chat.*`, `threshold.*`, `biometric.*`).
  - **Money normalization (contract change)**: every `Decimal` money field
    serializes to a **fixed 2-decimal string** (`"2500.00"`) via
    `src/common/money/money.ts` — applied in the feature services (wallet
    `balance`, transaction `amount`, threshold `thresholdValue`, card limits)
    **and** the admin `CrudService` (admin consumers now also get 2dp).
  - Tests: 5 e2e files (`accounts-wallets`, `cards`, `chats`,
    `transactions` incl. approvals+thresholds, `biometrics-audit`) against the
    extended `seedBaseFixtures` (account+wallet, messages with fixed
    `createdAt`, PENDING transaction + approval, threshold, notification,
    biometric device for SEED_USER; the SEED_OTHER user intentionally has none)
    + per-service unit suites covering the new CRUD paths.

- **Storage (Phase 6)**: Supabase Storage foundation.
  - `StorageService` (`src/common/storage/`, `@Global()`) wrapping the Storage
    REST API with the server-only service-role key: signed upload URLs
    (`POST /object/upload/sign`), signed read URLs (`POST /object/sign`),
    stable public URLs (public buckets), server-side upload, remove, list, and
    idempotent bucket creation.
  - Fixed bucket catalog (`bonde-avatars` public; `bonde-kyc-docs`,
    `bonde-chat-files` private) with per-bucket content-type allowlists, size
    caps, and `expiresIn` bounds; unsafe paths (`..`, leading `/`, spaces),
    unknown buckets, and non-allowlisted content types are rejected before any
    HTTP call. Fail-closed (uniform `503`) when Storage is unreachable.
  - Thin auth-protected endpoints: `POST /api/storage/upload-url`,
    `GET /api/storage/signed-url`, `GET /api/storage/public-url` (no file
    proxying; avatars/KYC/chat flows build on these in Phase 7).
  - Tests: 24 new unit cases (guardrails, URL/object flows, error mapping) +
    7 e2e (auth, buckets, unsafe paths, content-type allowlist, public/private
    URL rules) with stubbed `fetch`.
  - Docs: AGENTS.md `## Storage (Supabase)` section.

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
- **Auth (Phase 3)**: Supabase JWT verification + RBAC (verify-only at the
  time — clients authenticate against Supabase Auth directly). Superseded as
  the full auth story by **Auth BFF over Supabase** above; JWKS verification +
  RBAC remain the trusted-token path for authenticated routes.
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
- **Caching & rate limiting (Phase 5)**: Redis on both fronts.
  - New `CacheModule` + `CacheService` (`src/common/cache/`): cache-aside
    `get<T>`/`set` (JSON + `PX` TTL), `del`, SCAN-based `invalidate('pattern:*')`,
    and single-flight `getOrSet(key, ttl, loader)` (per-process). Keys prefixed
    `cache:`. Fail-open like the throttler: Redis outage → misses pass through
    to the source, warn-once logging.
  - Named throttles: global config now registers `default` (env-driven, all
    routes) plus an opt-in `strict` throttle enforced only where handlers are
    marked `@StrictThrottle()` (`src/common/throttle/`), wired via
    `ThrottlerGuard`'s `skipIf` so existing endpoints are unaffected. Strict
    defaults: 5/min, 5-min block (env-tuned via `THROTTLE_STRICT_*`). Intended
    for security-sensitive flows (OTP send/verify, etc.).
  - Tests: 42 unit (incl. cache round-trip, invalidate, single-flight, fail-open)
    + 13 e2e incl. a 429-on-limit case.
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
  - `RedisClient` interface extended with `del` + `scanIterator` (SCAN-based
    deletion for cache invalidation).

### Changed

- **Source reorganization (feature-module layout)**:
  - Feature modules moved under `src/modules/` (`auth/`, `health/`), with auth
    split into `principal/`, `guards/`, `decorators/`, and `services/`.
  - `common/` tidied: rate-limit storage + `@StrictThrottle()` consolidated in
    `common/throttling/`; `ApiErrorDto` + `@ApiErrorResponse()` grouped in
    `common/errors/`; 404 catch-all moved to `common/http/`.
  - No file renames or exported-symbol changes — only import paths moved.
  - `AGENTS.md` gained a **Module structure** section documenting the layout and
    placement conventions for new features.
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