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

### Changed

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