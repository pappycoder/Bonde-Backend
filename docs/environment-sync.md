# Vercel environments and checked deployments

Each repository has a private `.env.vercel.json` and a committed, empty
`.env.vercel.example.json` listing the application variables. Run `npm run
env:init` (or `pnpm env:init`) when creating a private file from the template.
The private file is git-ignored, excluded from Vercel uploads, and written with
mode 0600. Never commit a populated manifest. Mobile uses the same format for
public build configuration; it has no Vercel application or server credentials.

The three variable sections are:

- `shared`: reusable AI/email/SMS credentials and common application settings.
  These are merged into preview and production. Each project syncs separately.
  NEXT_PUBLIC_* values are shared too, except API URLs.
- `preview`: staging values, used by the `staging` branch.
- `production`: production values, used by `main`. Initially these are empty.

Environment values override shared values when nonempty. An empty value is
omitted from pushes; it never creates, updates or deletes a remote variable.
Removing an existing remote variable is an explicit separate operation. Database,
Supabase Auth, banking, webhook/job, and encryption credentials cannot be shared.
Do not put Vercel deployment tokens or GitHub credentials into application envs.

## Commands

Run from the repository root:

```sh
./bonde.sh env:plan --environment preview
./bonde.sh env:pull --environment preview
./bonde.sh env:pull --environment preview --from production
./bonde.sh env:push --environment preview --dry-run
./bonde.sh env:push --environment preview
./bonde.sh env:push --environment all
./bonde.sh env:validate --environment production --deployment
./bonde.sh env:github --environment all
./bonde.sh env:export --environment preview --output .env.local
```

Equivalent package commands are `env:plan`, `env:pull`, `env:push`, `env:validate`,
`env:github`, and `env:export`. With npm, pass arguments after `--`. The workspace
helper also supports `./bonde.sh env:pull all --environment preview` from the
parent Bonde directory. Flutter projects can use these Node tooling commands
without installing npm application dependencies.

Use `--from production` only for the initial import of legacy development values
into preview. Normal pulls select their actual Vercel environment. Vercel cannot
return protected secret values. Pulls retain known local values, leave unknown
ones empty, and record names in `_meta.unreadable`. `[SENSITIVE]` placeholders
are never accepted as credential values. `_meta.localFallbackKeys` records keys
initially supplied from the local .env instead of a readable remote value.
A pre-existing Vercel variable spanning multiple targets must be split before a
single-environment sync; the tool refuses to risk rotating another environment.

The current hosted production values are treated as legacy staging inputs.
Existing production-target Vercel values are not deleted by empty production
entries. Keeping that legacy deployment online does not authorize using its
staging database for a new production deployment.

## GitHub and deployment order

The staging GitHub environment is restricted to `staging`; production is
restricted to `main`. `BONDE_ENV_JSON` contains the selected environment and
shared values as an encrypted environment secret. Database/Supabase values are
also stored as separate environment secrets. Production database secrets stay
absent until an independent production project exists. `env:github` skips empty
credentials and does not delete an already-existing secret.

Vercel project/org IDs and optional `STAGING_DOMAIN` are environment variables.
`VERCEL_TOKEN` is a dedicated project-scoped CI secret, separate from the app's
keys. If provisioned with a 90-day lifetime, rotate it before expiry; its metadata
is recorded in the private manifest. A CLI login token is not used as the CI key.

Every PR and push to main/staging runs the quality checks. `All checks passed`
requires every check to succeed, including non-skipped jobs. Deployment jobs run
only after that gate and only for branch pushes, never fork/PR code. Automatic
Vercel Git deployments are disabled by `vercel.json`; CI owns deployment.

Deployment validates the selected manifest before touching Vercel or the database,
builds the actual target with the selected environment, then (backend only) runs
`prisma migrate deploy`. Runtime and migration URLs must refer to the same DB;
production must differ from the recorded staging database and Supabase Auth
project. Failed CI/builds never apply staging/production migrations. Deployments
are serialized and stale branch commits cannot be promoted. Schema migrations
are not automatically reversed if a later application health check fails.

CI stages an unaliased production deployment, health-checks it, and only then
promotes it. Staging creates a preview deployment and may attach STAGING_DOMAIN.
The existing development API can remain api.usebonde.com; leave future production
URLs empty until the production environment is ready. Manual operator CLI deploys
are outside the GitHub gate and should not be used to bypass failed checks.

Mobile's environment build waits for analysis, tests and the debug APK check.
Staging uses the dev flavor; main uses prod. Android accepts the selected public
API_URL from CI, and prod has no hardcoded staging fallback. These jobs validate
APK builds; they do not upload to app stores or configure production signing.

Before activating production, supply its independent database, Supabase Auth,
encryption/signing/job keys, production URLs and approved provider configuration;
update encrypted GitHub secrets with env:github, then merge a passing PR to main.


Backend migration commands:

```sh
# Use a local disposable database, never staging/production, to create reviewed SQL.
MIGRATION_DATABASE_URL=postgresql://bonde:bonde@127.0.0.1:5433/bonde pnpm db:migration:create --name describe_change
pnpm db:migration:check
pnpm db:migrate:deploy --environment preview
```

Commit generated prisma/migrations SQL with the schema change. CI compares the
migrated local test database against schema.prisma and fails for missing migrations.
After all checks and the environment build pass, it deploys those committed
migrations to the selected database. Production requires its independent values.
