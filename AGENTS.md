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

## Conventions
- **ESM only.** All relative imports include the `.js` extension (NestJS 12 `nodenext` resolution). Do not import without the file extension.
- TypeScript **strict**. Avoid `any` except where oxlint explicitly allows it (`no-explicit-any` is off).
- Do not access `process.env` directly in feature modules — use the typed config (`ConfigService` with `AppConfig`) defined in `src/config/`.
- Follow NestJS modular structure: one feature directory per domain with controller / service / module / DTOs.
- Never commit `.env`, secrets, or the Supabase service-role key.
- The Supabase service-role key is **server-only** and must never reach a client.

## Verification
Run `pnpm check` before finishing. If e2e fails due to missing Supabase credentials, note the requirement rather than disabling the test.
