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
- Schema lives in `prisma/schema.prisma` (23 tables, datasource has NO `url`).
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
    `NOT_FOUND`, `VALIDATION` (GoTrue 4xx payload rejection),
    `CONFIG` (service-role / project misconfigured), `PROVIDER` (network / unmapped).
  - `services/` (`auth.service.ts`, `auth-tokens.service.ts`): orchestration +
    short-lived HS256 `registration`/`reset` tickets (`AUTH_TOKEN_SECRET`,
    Redis nonce `auth:nonce:{purpose}:{jti}`). The `verify*` helpers only check
    the nonce; `consume*` revokes it — **always consume AFTER the protected
    step succeeds** so a wrong code never burns the ticket.
- Auth routes are `@Public()` + `@StrictThrottle()`: `POST /api/auth/register`
  (201 → `{ status, registrationToken }`), `POST /api/auth/verify-email`, `POST
  /api/auth/resend-verification-otp`, `POST /api/auth/login`, `POST
  /api/auth/login/mfa`, `POST /api/auth/refresh`, `POST
  /api/auth/forgot-password`, `POST /api/auth/verify-reset-otp`, `PATCH
  /api/auth/reset-password`. `GET /api/auth/me` stays authenticated.
- **Sessions & password change**: `auth_sessions` mirrors the Supabase
  `session_id` (written on login/refresh, `GET /api/auth/sessions`,
  `DELETE /api/auth/sessions/:id` to revoke one, `POST /api/auth/logout` for the
  current one). `POST /api/auth/change-password` re-verifies the current password
  via a throw-away GoTrue grant (GoTrue has no password-check endpoint), then
  revokes every *other* session and emails the user. A revoked device keeps its
  access token until it expires but can never refresh again.
- **Second factor (TOTP)**: `two_factors` holds one row per profile
  (`secretEnc` AES-256-GCM under `encryption.mfaKey`, `recoveryHashes`
  SHA-256 digests, `enabledAt`, `lastUsedStep`). Routes: `GET /api/auth/2fa`,
  `POST /api/auth/2fa/setup` (password re-checked, returns `secret` +
  `otpauthUri`), `POST /api/auth/2fa/enable` (first valid code → 10 single-use
  recovery codes, shown once), `POST /api/auth/2fa/disable` (password **and** a
  current code). When a factor is on, `POST /api/auth/login` answers
  `{ mfaRequired: true, challengeId, expiresIn: 300 }` and parks the provider
  session in Redis (`auth:mfa:<uuid>`, `MfaChallengeService`) — no token is
  released until `POST /api/auth/login/mfa` accepts the code, and the challenge
  is consumed (deleted) on the first attempt, so a wrong code forces a fresh
  login. TOTP codes are accepted once per 30s step (`lastUsedStep` blocks
  replay); `encryption.mfaKey` falls back to `CARD_ENCRYPTION_KEY` when
  `MFA_ENCRYPTION_KEY` is unset.
- Register surfaces GoTrue payload validation as 400, duplicate accounts as 409, and provider / service-role misconfiguration as 503.
  `email_confirm:false` user (service-role `createUser`) and `login` returns
  403 until `verify-email` succeeds. `forgot-password` always answers 200 — no
  user enumeration. Emails are normalized to lowercase.
- **Registration provisions only the `profiles` row** (1:1 mirror of
  `auth.users`, `emailVerified: false`). **Email verification completes the
  registration**: `verifyEmail` atomically marks the profile verified and
  provisions the user's single account + wallet (`AccountType.CHECKING`, Luhn
  account number, zero balance) in one `prisma.$transaction`
  (`UserProvisioningService.provision` in
  `modules/auth/services/user-provisioning.service.ts`, shared with invite
  acceptance), so provisioning is
  eager/automatic and never left to a later onboarding step. The provisioning
  is idempotent and its failure rolls back before the single-use registration
  token is consumed.
- New authenticated routes are protected by default; opt out with `@Public()`.
  Roles are assigned in Supabase (dashboard / edge function), never in
  PostgreSQL.

## Invitations (admin-issued, single-use)
- `user_invites` rows are created **only** by an authenticated
  `ADMIN`/`SUPER_ADMIN` (`InvitesController`, `/api/admin/invites`): `POST`
  (issue + email), `GET` (paged, `?q&status=pending|accepted|revoked|expired`),
  `POST /:id/revoke`. The raw token is generated once (`randomBytes(32)`,
  base64url) and **never stored or returned** — only its SHA-256 digest lands in
  `token_hash`, and the emailed link is the sole copy
  (`<ADMIN_APP_URL>/accept-invite?token=…`).
- Delivery is **fail-closed**: if the invite email cannot be sent the row is
  deleted and the request answers 503, because the token is unrecoverable
  otherwise. Re-issuing an address revokes its live invite (one live invite per
  email) and 409s if the address already has a `profiles` row.
- Redemption is public and lives in `InvitesPublicController`
  (`GET /api/auth/invites/accept?token=` → `{ email, fullName, role, expiresAt,
  valid }`; unknown tokens answer the same shape with `valid: false`, so nothing
  is enumerable). `POST /api/auth/invites/accept` is `@StrictThrottle()` and
  claims the token with a guarded `updateMany({ acceptedAt: null })` **before**
  calling the provider, so a lost race cannot orphan an `auth.users` row; a
  provider rejection releases the claim (retryable), a weak password never burns
  it. The user is created with `email_confirm: true` and the invite's role in
  `app_metadata` (the emailed link is the email proof, so there is no OTP dance),
  then the profile + account + wallet are provisioned by the shared
  `UserProvisioningService`. Audits: `admin.invite.create|revoke`,
  `auth.invite_accepted`, `mail.invite`.
- `ADMIN_APP_URL` (typed config, Joi `uri`, default `http://localhost:3000`) is
  the admin-console base URL used to build invite links.

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
- **Delivery address**: authenticated `GET/PUT /api/profile/delivery-address` reads or
  replaces the owner's one saved address (`delivery_addresses`, profile FK with cascade).
  GET returns JSON `null` when none is saved. Street, city, region and country are
  required; optional addressLine2/postalCode default to empty strings. Recipient
  name/phone stay on the profile. Updates record `profile.delivery_address.update`
  without address contents in the audit. Chat agent context includes these details;
  approved payment instructions return `requiresDelivery`, `deliveryAddress` and
  `recipient`. Trusted `requiresDelivery` overrides mode defaults (retail or
  unclassified requires delivery; flight/subscription/software does not). Mobile
  confirms delivery details before showing the manual merchant/card handoff.
- **OTP**: codes are **4-digit** (`OTP_CODE_LENGTH = 4`), stored as **SHA-256
  digests** (never plaintext), 5-min TTL, single-use; sending a new code
  invalidates earlier ones. `OtpService` exposes principal-free primitives
  `generateCode(userId, channel)` (returns the plaintext), `consumeCode(userId,
  channel, code)` (boolean) and `invalidate(userId, channel)`; the `send` /
  `verify` self-service endpoints wrap them. Targets must be the caller's own
  email (EMAIL) or principal/profile phone (PHONE). Delivery crosses the
  `OTP_SENDER` token (`src/modules/otp/otp-sender.interface.ts`) — production
  backs it with `RoutingOtpSender` (Termii SMS / `ResendOtpSender` for email,
  which delegates to the shared `MAIL_SENDER` + verification-code template).
  **Fail closed**: a `OtpSendError` becomes a 503 *and* the just-created code
  is voided.
- **Throttling**: `send`/`verify` are stamped `@StrictThrottle()` (strict
  throttle, env-tuned). The response never includes the code; tests capture it
  by overriding the `OTP_SENDER` provider.

## Email (Resend + templates)
- `src/common/mail/` is the **only** place that talks to Resend: `MailService`
  (`MailSender`, `POST /api/emails`, 10s timeout, fail-closed `MailSendError`
  whose message includes the Resend status + response snippet for server-side
  visibility) is provided under the `MAIL_SENDER` token in the `@Global()`
  `MailModule` (`{ provide: MAIL_SENDER, useExisting: MailService }`). Delivery
  failures throw in every environment, including development; never report a
  logged message as delivered or log credential email bodies. Feature code must
  inject **`MAIL_SENDER`**, never Resend directly — e2e overrides the token
  with a capture stub to keep real email out of tests (auth + cards suites do).
- Templates live in `src/common/mail/templates/` — pure TS renderers (no new
  runtime deps), sharing `layout.ts` (max-width **560px**, inline-CSS tables,
  hidden preheader, near-black gradient header, tinted footer, **no CTA
  buttons**) and the `esc()` escaper in `parts.ts`.
  - **Bodies are declarative.** `LayoutOptions.sections` takes an `EmailSection[]`
    (`lead`/`paragraph`/`note`/`code`/`facts`/`bullets`/`link`/`divider`) rendered
    by `sections.ts`, so renderers never concatenate HTML and every block
    escapes through one chokepoint. Pass **raw** text to the layout —
    pre-escaping double-encodes `&` and apostrophes. `link` is for when the link
    *is* the content (invite URL); the design system still has no CTA buttons.
  - `theme.ts` owns the palette (light `brand`, dark `brandDark`, `header`,
    `font`, `CARD_WIDTH`). `links.ts` owns legal/social/support URLs — all
    footers come from `emailFooter()`.
  - **Dark mode is three-layered.** Light colours are inlined on each element
    (Gmail ignores `prefers-color-scheme` and applies its own forced dark),
    `@media (prefers-color-scheme: dark)` covers Apple/Yahoo/Outlook-Mac, and
    `[data-ogsc]`/`[data-ogsb]` selectors cover Outlook.com, which rewrites
    colours and tags what it touched. Those rules need `!important`. The header
    repeats `background-color` before `background-image` because Outlook's Word
    engine drops the shorthand.
  - **Assets** are registered in `templates/assets/index.ts` (`file`, HTTPS
    `src`, `alt`, source `dataUri`). HTML always uses public HTTPS PNG URLs.
    The default is the existing public Supabase logo folder; deployments can
    override **`MAIL_ASSET_BASE_URL`** for all assets or **`MAIL_LOGO_URL`** for
    the logo alone (base URL takes precedence). Never send data URIs or signed
    image URLs. The original embedded sources are retained only for asset
    regeneration and compatibility with previously rendered HTML. Logos remain
    transparent without a white container, per user preference. Keep the
    surrounding email design unchanged. `node scripts/preview-mail.mjs` after
    `pnpm build` regenerates fictional HTML samples in `docs/previews/emails`.
- **Verification purposes** are threaded, not assumed: `OtpSendRequest.purpose`
  (`VerificationPurpose`) reaches `verification-code.ts`, which has distinct
  copy per flow. `AuthService.forgotPassword` sends `'recovery'`, so a reset code
  no longer arrives worded as an email-verification confirmation. The union is
  only `verify-email | recovery` — login is password-only and the second factor
  is TOTP, so neither sends an email code; adding a member means wiring the call
  site and its copy together. An unknown purpose throws instead of rendering
  `undefined` into a credential email. Never put an OTP in the preheader — the
  inbox preview shows on a lock screen.
- **Long tokens wrap**: `<body>` sets `word-break`/`overflow-wrap`, so codes,
  account numbers and join URLs cannot force a horizontal scroll on a narrow
  client. The invite join URL is a real anchor (`{ kind: 'link' }`) because the
  single-use token is shown exactly once, in that email.
- **Two delivery policies**:
  - **Fail-closed (credentials)**: OTP code emails. `ResendOtpSender`
    (`src/modules/otp/`) delegates to `MAIL_SENDER` with the
    `verification-code` template at the requested purpose and still throws
    `OtpSendError` so the OTP flow voids the code and answers 503.
  - **Best-effort (non-critical)**: welcome (`AuthService.verifyEmail` after
    provisioning), password-reset confirmation (`resetPassword`),
    card-registered (`CardsController.create`). Failures are audited
    (`mail.welcome`, `mail.password_reset`, `mail.card_registered`) and never
    fail the request.
- Credentials (codes) and personal data (limits, account numbers) are fine in
  emails; the PAN never is — only `cardNumberLast4` may be shown.

## Public marketing site (Bonde-Web)
- `src/modules/marketing/` serves the public website (Bonde-Web). Two
  **unauthenticated** writes, both `@Public()` + `@StrictThrottle()`:
  `POST /api/waitlist` (`{ email, firstName, lastName, phone, source? }`, 201, idempotent per email —
  a repeat answers `alreadyJoined: true` without a new row or team notification,
  and resends the visitor’s membership confirmation) and
  `POST /api/contact` (`{ name, email, subject?, message }`, 201).
- Both persist synchronously (`waitlist_signups`, `contact_messages`) and then
  notify `CONTACT_INBOX_EMAIL` (default `usebonde@gmail.com`) **best-effort** via
  the `MAIL_SENDER` token — the row is the source of truth, so a mail outage
  never fails a visitor's submission. Waitlist submissions also send a branded
  confirmation to the visitor, with distinct copy for repeat signups. Templates: `contact-message.ts`,
  `waitlist-signup.ts`, `waitlist-confirmation.ts`. Confirmation delivery attempts
  are audited as `mail.waitlist_confirmation` with a `sent` flag. Writes are audited
  (`marketing.waitlist.join`, `marketing.contact.create`) and successful sends
  are audited (`mail.waitlist`, `mail.contact`).
- Admin read access is **registry-driven**, not a dedicated controller:
  `waitlist` and `contacts` are registered **read-only** (`list`, `get`) in
  `crud.registry.ts`, so `GET /api/admin/waitlist` and `GET /api/admin/contacts`
  (paged, `q`, `orderBy=createdAt:desc`) come from `CrudService`; POST/PATCH/
  DELETE answer 405.
- Rows carry no owning profile — the waitlist is deliberately pre-account.

## Admin CRUD (registry-driven data-grid)
- `src/modules/crud/` exposes `POST/GET/PATCH/DELETE /api/admin/:resource[/:id]`
  — admin mutates most tables through a generic, field-safe layer. The **source
  of truth is the registry** (`crud.registry.ts`): each resource declares its
  field `kind` (`uuid|string|int|decimal|boolean|enum|json|datetime`),
  required/writable/visible sets, and allowed methods (it asserts invariants at
  boot). `CrudService` coerces/validates payloads and maps Prisma errors to the
  uniform contract (P2002→409, P2025→404, P2003/P2011/P2012→400).
- Query contract: `?page&pageSize` (pageSize ≤ 100), `q=<text>` (case-insensitive
  `contains` over the resource's `searchable` fields; `q` on a resource with none
  → 400), `filter=field:value` / `filter=field:op:value` on visible fields only
  (ops `eq`, `contains`, `startsWith`, `endsWith`, `gt`, `gte`, `lt`, `lte`).
  Operator-less `field:value` is flexible: **string fields partial-match
  (case-insensitive `contains`)** while enum/uuid/boolean/number/date fields use
  equality — use `field:eq:value` to force exact. `orderBy=field:asc|desc`.
  Responses are `{ items, total, page, pageSize, totalPages }`; responses/rows
  are projected to **visible** fields and Date/Decimal are serialized (ISO /
  string).
- **Exclusions are deliberate**: `profiles`, `accounts`, `wallets`, `cards`,
  `transactions`, `transaction_approvals`, `otp_codes` are NOT in the registry
  — they stay on dedicated, hardened flows. `card-providers.config` (API
  secrets) is absent from the registry so it is never written to or read back.
  `virtual_accounts` and `provider_events` (provider money-movement sinks) are
  also excluded — funding/issued-card flows own them. `audit-logs` is read-only
  (POST/PATCH/DELETE → 405 `MethodNotAllowedException`).
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
- **Accounts and wallet metadata are provisioned at email verification.**
  `GET /api/account` displays the real Safe Haven deposit number only after banking
  setup. `GET /api/wallet` presents the NGN ledger balance, allocations and holds.
  Both are read-only; historical/sample balance columns are never monetary authority.
- **Cards**: read-only owned Sudo cards at `/api/cards`, with allocation balances,
  plan capacity, history, verified merchant identifiers and active rule projections.
  All issuance, allocation, return, rules and lifecycle changes use `/api/finance`.
  Sensitive card details use a scoped secure display session after server passcode
  verification; native clients never receive PAN or CVV.
- **Transactions**: `/api/transactions` and `/recent` show live operation/provider
  projections. Only the finance services create or settle financial activity.
  `/api/approvals` presents card authorization requests; approval grants one exact
  retry for five minutes. Chat proposal decisions remain in their owning chats.
  Threshold configuration remains user CRUD at `/api/thresholds`.
- **Chats**: `/api/chats` history + CRUD; `/api/chats/:id/messages` lists
  chronologically (secondary `id` sort makes seeded `createdAt` ties
  deterministic) and `POST` appends only `USER`-role messages (assistant
  replies come from the AI pipeline). A DB trigger stamps `chats.updated_at`
  with the inserted message's `created_at`, so a chat's `updatedAt` always
  reflects the most recent message — in-app or pipeline-write.
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
  `card.create|update|pause|resume|limit|lock.*|category.*|merchant.add|merchant.remove`,
  `chat.*[.message]*`, `threshold.*`, `biometric.*`).
- **Core mutations notify the acting user**: feature controllers route their
  metadata and non-financial create/update/delete writes through `ActivityService.record`
  (`src/modules/activity/`) — one awaited call that writes the append-only
  audit entry **and** creates an in-app `Notification` row for the caller
  (type `CARD|TRANSACTION` where applicable, `SYSTEM` otherwise; `metadata`
  carries `{action, entityType, entityId}` for client routing). Copy is inline
  per handler (`activity-copy.ts` provides the `humanizeLabel()` enum
  lower-caser). Wired for account, wallet, transaction, approval, threshold,
  biometric and profile operations. Financial commands record their own atomic audit and notification.
  **Audit-only** (plain `AuditLogService.record`, no notification): admin CRUD,
  auth provisioning, chats, card lock/category/merchant sub-actions.

## Sudo cards and Safe Haven banking
- `src/modules/finance/` owns every financial mutation. Commands use a server-verified
  passcode proof bound to the exact payload, an idempotency key and a balanced ledger.
- `GET /account`, `/wallet`, `/cards`, `/transactions` and `/approvals` are presentation
  APIs. There are no financial CRUD or raw credential endpoints. Wallet/card amounts
  come from `FinanceAccount`; old wallet balances remain historical data only.
- Safe Haven provides verified NGN deposit subaccounts and bank transfers. Sudo provides
  virtual cards, authorization decisions and scoped secure display sessions. Configure
  provider credentials and validation gates as documented in `docs/sudo-safehaven.md`.
- All existing mobile financial screens use this flow without a build-time switch.
  Cards hold separate allocations; explicit operations allocate or return funds.
- Chat purchase proposals hand off to funded virtual cards for merchant checkout.
  Merchant purchases are confirmed by provider events. There is no local or placeholder
  merchant checkout executor, and administrators cannot settle purchases manually.
- USD cards and conversion stay disabled pending programme validation. Disabled
  providers never activate a sample or direct balance write fallback.
- Retain historical financial rows and migrations. Never import sample balances as
  live liabilities. The immutable installation marker prevents mixing environments.

## Database & testing
- Runtime DB is Supabase Postgres (`DATABASE_URL` pooled, `DIRECT_URL` direct)
  via the `PrismaPg` driver adapter. **e2e DB suites instead run against a local
  dockerized Postgres** (`postgres` service in `docker-compose.yml`, port
  `5433`, `postgresql://bonde:bonde@localhost:5433/bonde`) — runtime env is
  untouched.
- `test/db.ts` owns the constants + fixtures: seeded profiles use **real UUIDs**
  (`SEED_USER_ID` etc.) because `profiles.id` is `@db.Uuid`; `truncateAll`
  TRUNCATEs all tables CASCADE; `seedBaseFixtures` upserts the profile/
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
  `/15` OTP, `/10` auth, `/11` invites) with env overrides restored in
  `afterAll`, and `test/global-setup.ts` flushes `0,10,11,12,13,14,15` so
  counters never leak between runs (db **16** is deliberately absent: a stock
  Redis has 16 databases and an out-of-range index surfaces as an unhandled
  ioredis error event). `bootE2EApp` awaits Redis `ready` before returning so every
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
                   supabase/ gateway client, services/ orchestration + tickets,
                   device sessions, TOTP second factor)
    health/        terminus health/readiness probes
    profiles/      self-service profile (GET/PATCH /profile, avatar)
    otp/           app-level phone/email verification (send/verify)
    invites/       admin-issued single-use join links (issue/revoke + public
                   accept; acceptance provisions exactly like verification)
    marketing/     public website waitlist + contact writes (admin reads via the
                   read-only `waitlist`/`contacts` CRUD registry resources)
    notifications/ mobile notification feed (list/read/read-all)
    audit/         append-only AuditLogService.record + self-service audit-logs
    activity/      ActivityService.record — one-call audit + in-app notification
    crud/          generic admin data-grid (registry + /admin/:resource)
    accounts/      read-only account presentation (1:1 via unique Account.userId)
    wallets/       read-only ledger wallet presentation
    finance/       Sudo/Safe Haven providers, ledger, commands, identity, events,
                   authorization, durable workers and reconciliation
    funding/       verified saved recipients, deposit account and budget presentation
    cards/         read-only Sudo card presentation and plan access
    chats/         chat history + messages (+USER message append)
    transactions/  read-only live transactions and authorization approvals
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
  dependency) when a dependency is down; `/api/health/ready` stays `200`. Both
  failure shapes count: Terminus' `ServiceUnavailableException` **and** a raw
  client error from a dead socket (ioredis `MaxRetriesPerRequestError`) — a
  socket-level Redis death must not surface as a 500.
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
