# Admin AI usage, funding estimates and alerts

The admin console's **AI usage** page (`/ai-usage`) shows overall and per-user
OpenAI tokens, provider requests, estimated USD costs, and current Bonde reply
credits. User detail pages link to the corresponding filtered view. Usage can be
filtered to the last 24 hours, 7, 30 or 90 days; chart buckets and timestamps use
Africa/Lagos. Customer credit balances are current, while consumption counters
use the selected reporting period.

## Deployment and initial setup

1. Generate the Prisma client and deploy the additive migration **before** running
   the updated backend: `pnpm prisma:generate` and `pnpm prisma:deploy`.
   The migration is `20261113000000_ai_usage_monitoring`. Test it against a staging
   database before production deployment. No application database is migrated by
   the automated tests.
2. Set `AI_USAGE_MONITORING_ENABLED=true` in the backend environment and restart
   the backend. It defaults to false, so existing shopping requests keep working
   while deployment approval or database migration is pending. Disabled monitoring
   does not access the new tables or start alert jobs.
3. In the admin page, expand **Provider pricing**. Enter the rates from your own
   provider plan. OpenAI uses USD per million input, cached-input and output
   tokens for the configured model. Brave uses USD per thousand successful
   searches; its internal model identifier is `brave-search`. There are no
   assumed default prices. Saving a rate creates a version for future requests.
4. Record each provider's **current available balance**, not the sum of all past
   deposits. This establishes an opening baseline now. Costs from requests begun
   before the baseline are excluded from its balance calculation.
5. Expand **Alert thresholds and recipients**, enter the admin email addresses,
   and save. Defaults are warning at 20% and critical at 10% remaining. Recipients
   are initially empty; dashboard alerts work without email recipients.
6. Ensure the backend's shared Resend mail configuration is working. The **Check
   thresholds and send pending alerts** button exercises the normal outbox.

Long-running backends evaluate thresholds and deliver due alert emails every
minute. Serverless deployments must invoke the existing protected
`POST /api/shopping/jobs` endpoint at least once per minute with
`Authorization: Bearer <FINANCE_JOB_TOKEN>`. Monitoring is included in that job;
it does not depend on someone keeping the dashboard open. Do not expose the job
token or provider API keys to the admin browser.

## What is measured

Every real OpenAI or Brave request through the application first writes a
`PENDING` receipt. If that write fails, the provider is not called. A completed
request records provider, model, user/chat identity, status, latency, reported
tokens and the applicable pricing version. No prompt, answer, provider key or
authorization header is stored in these receipts. Provider and network failures
remain visible. A killed process or failed receipt finalization leaves a visible
pending/unknown-cost record rather than a fabricated zero.

Cached input tokens are a subset of input tokens; reasoning tokens are a subset
of output tokens. They are never added twice. Brave cost is per successful
provider request, not per returned result. Redis hits and coalesced search
waiters make no additional Brave request. Off-topic/free-to-customer replies can
still incur provider costs, which are recorded independently of customer credits.

Receipts are independent of chat-turn retries. A retry creates another receipt;
it cannot overwrite the first attempt's usage. Finalized receipts, pricing
versions and funding entries are immutable in the database. Regular tests use
fake providers and captured mail; the explicit product smoke command intentionally
uses memory-only services and does not write application monitoring records.

Historical `ai_chat_turns.usage` counters are not backfilled into this ledger:
they can omit earlier retries and do not provide complete cached-token pricing
detail. Reporting starts when this migration and instrumentation are deployed.

## Funding and replenishment

Provider funding is an **admin-maintained estimate**, not a provider-reported
balance and not a customer wallet liability. Recording an opening balance, top-up
or reconciliation does not transfer money or buy anything at the provider.

The estimate is the opening/reconciled balance plus subsequent recorded top-ups,
minus known costs for metered requests since that baseline. Unknown or unpriced
requests are counted explicitly, and the balance can overstate available funds.
Runway is hidden while costs are incomplete. Otherwise it uses the recent daily
spend rate (up to seven days); it is an estimate, not a guaranteed exhaustion date.
Keys used by other apps, taxes, provider credits, refunds and external usage may
also make provider billing differ from the estimate.

Record a **top-up** only after funding the provider. The alert percentage base is
the estimated available balance immediately after that entry, not lifetime
deposits. A top-up resolves the previous alert cycle and rearms thresholds.
Funding submissions use an idempotency UUID, so retrying the same request does
not add funds twice. Reusing its UUID with different details is rejected.

If costs were uncertain, check the actual balance at the provider and select
**Reconcile current available balance**. This starts a new baseline without
deleting older receipts or funding history. Unknown costs before that baseline
still appear in historical usage, but no longer contaminate the new balance.

## Alerts and access

An alert is persisted once per provider, funding cycle and severity. If balance
is already critical, a critical alert is created without also sending a warning
for the same observation. A database lease prevents simultaneous workers from
delivering the same outbox entry. Successfully delivered recipients are retained;
only unsent recipients retry, with increasing delays up to one hour. As with
normal email outboxes, a process crash between delivery and recording the receipt
can cause an at-least-once duplicate. The dashboard shows recipients, delivery
counts, attempts and resolved status. No test sends a real low-balance email.

All `/api/admin/ai-usage` endpoints require ADMIN or SUPER_ADMIN. Settings,
funding and pricing changes are audited atomically with the mutation. New tables
have row-level security enabled without direct client policies; access is through
the privileged backend database connection and role-protected API.

- `GET /api/admin/ai-usage?days=30&page=1&q=&userId=<optional UUID>` — overview,
  model breakdown, trends, current funding, users, recent calls and alerts.
- `PUT /api/admin/ai-usage/settings` — provider, warning/critical percentages and
  email recipient list.
- `POST /api/admin/ai-usage/rates` — versioned pricing for future requests.
- `POST /api/admin/ai-usage/funding` — idempotent opening/top-up entry; optional
  `operation: "BALANCE"` records a newly observed balance baseline.
- `POST /api/admin/ai-usage/check` — evaluate thresholds and process due email.

Money is returned as decimal strings in USD. Never interpret provider token
counts, provider funding estimates and Bonde customer reply credits as the same
unit. Uninitialized customer allowances are displayed as not issued, not silently
provisioned by an admin reporting request.
