# AI shopping and service purchases

## Enablement

Use a coordinated cutover: pause billing/chat writes, retire old backend instances,
deploy migrations with `pnpm prisma:deploy`, then start all writers on this version
and restore traffic. Do not mix old counter-only billing writers with the new
credit-ledger writers during a rolling deployment. The two
additive migrations create credit grants/events/turns, shopping evidence, service
quotes/orders/reminders, and supplier balance snapshots. No existing monetary or
credit entitlement is discarded. Existing credit balances are backfilled under
an owner row lock on first use; their `ledgerInitialized` marker prevents a second
welcome grant. Run `pnpm prisma:generate` when building.

AI is disabled by default. Set `AI_SHOPPING_ENABLED=true`, `OPENAI_API_KEY`, and an
explicit Responses/function-calling capable `OPENAI_SHOPPING_MODEL`. Enable search
separately with `SHOPPING_SEARCH_ENABLED=true`, `BRAVE_SEARCH_API_KEY`, and a
comma-separated `SHOPPING_MERCHANT_HOSTS` allowlist of official merchant domains.
Empty allowlists deliberately return no merchant links. No merchant ordering API
is configured in this release; goods use external official checkout. The backend
never fabricates a product price or represents a search snippet as stock evidence.

In production, `AI_PRICING_APPROVED=true` is also required. Do not set it until
measured model/search costs and the commercial catalog have been reviewed. The
existing Premium allowance (8,000 credits for NGN6,000) and 50-credit pack (also
NGN6,000) have intentionally not been changed. One successful assistant reply costs
one credit. Model/token/search counters are saved on the turn for cost review.
Provider invoice costs are not silently inferred from an assumed model price.

## Credit and turn contract

`GET /api/billing/summary` adds `credits.spendable`, `reserved`, `canChat`,
`replyCost`, and `purchasedExpire`. Plan credits are used first, then welcome and
purchased credits. Purchased/welcome grants have no expiry. Expiry is enforced
on admission and summary reads, not by trusting an intermittent timer.

`POST /api/chats/:chatId/turns` accepts `{content, requestKey}` and returns 202
with a durable turn ID and saved USER message. Poll `GET .../turns/:id`, or recover
a lost submission using `GET .../turns/requests/:requestKey`. COMPLETED includes
the stored reply. Repeating a key with different text/chat returns 409. The older
message/respond endpoints use the same reservations and settlement service.

No valid credits returns HTTP402 with `code: AI_CREDITS_REQUIRED`, preserving the
existing error envelope. Completed responses are replayed without charging again.
Concurrent in-flight turns per user are restricted to one (HTTP409
`AI_TURN_RUNNING`). Failed/stale attempts release their original grant reservation.
Fenced attempts cannot commit a late response after release/retry. Expired grants
never become spendable when a reservation is released.

The assistant is limited to goods and supported cable/data services. A direct
unrelated response and owned-order status replies are uncharged. Valid shopping
clarifications and no-results replies cost one credit. Provider errors and invalid
responses do not. The final reserved reply finishes even if its plan period ends;
new requests must reserve other valid credits. Viewing history, receipts, approved
purchases, direct catalog APIs, reminders, and buying credits remain available.

## VTpass sandbox and money lifecycle

Set `VTPASS_ENABLED=true`, `VTPASS_ENVIRONMENT=sandbox`, and the sandbox API,
public, and secret keys. GET requests use the public key; POST uses the secret key.
Supported service IDs are dstv, gotv, startimes, mtn-data, glo-data, airtel-data,
and etisalat-data; actual fixed-price plans are always fetched from VTpass.
Cable accounts are verified by the provider. Data beneficiaries are validated as
Nigerian phone numbers, not falsely described as provider-verified identities.

The mobile quote review shows beneficiary, current plan price, fee, total, and
expiry before requesting a passcode. `/api/finance/services/proof` binds proof to
an owner-scoped immutable quote fingerprint; `/orders` consumes that proof once,
reserves wallet funds, and creates an idempotent order/transaction. Quotes are
valid for five minutes; proof for at most two. Changed price/account details
require a new quote/proof. Supplier prefunded balance is checked and stored in a
separate snapshot before reserving customer money. It is never added to customer
wallet balances. Gross supplier settlement has its own ledger account, separate
from customer funds and service fees.

A worker sends a claimed order only once using its persisted Lagos-formatted
request reference. Network failures and ambiguous/duplicate responses remain
PENDING. Restart recovery only requeries PROCESSING/PENDING references; it never
reposts them. Only matching delivered references/amounts settle successfully.
Definitive declines return the hold. Unknown outcomes keep it reserved and appear
in the operations reconciliation queue. No admin endpoint can manually mark an
order delivered or release an uncertain hold.

Configure the VTpass callback URL as
`/api/finance/services/webhooks/vtpass?token=<VTPASS_WEBHOOK_TOKEN>` over HTTPS.
Callbacks are acknowledged immediately and trigger authenticated provider requery;
the callback's claimed status is never authoritative. The token must be configured
or callbacks are rejected. Polling works independently of callbacks.

Production additionally requires `VTPASS_ENVIRONMENT=production` and
`VTPASS_LIVE_APPROVED=true`; only enable after provider provisioning, sandbox
acceptance, fee checks, and treasury-prefund reconciliation. No production keys
or paid provider requests are used by the repository tests.

## Jobs, reminders, and operations

Long-lived processes run lease cleanup, queued AI work, reconciliation, and
reminders periodically. Serverless deployments must schedule `POST
/api/shopping/jobs` using `Authorization: Bearer <FINANCE_JOB_TOKEN>` at least
every minute. An accepted turn is saved before its immediate best-effort execution;
the queued worker recovers it if the process exits. An interrupted RUNNING attempt
expires and can be retried without double settlement.

`GET /api/shopping/operations` is ADMIN/SUPER_ADMIN only: turn status counts,
recent model/token/tool/search usage, order counts, oldest uncertain order, and
latest supplier balance observation. Alert on aging pending orders, stale supplier
snapshots, credit releases/failures, and unusual usage. Match supplier statements
and reported balances against settlement journals before replenishing treasury.

Service purchase history is accessible from chat's receipt button even with zero
AI credits. Successful purchases can schedule a user-chosen reminder. Reminders
are delivered once through the in-app notification feed and link to the owned
purchase. Opening renewal requests a fresh quote and always requires fresh
approval/passcode. Scheduling or sending a reminder never authorizes payment and
does not claim to cancel an underlying third-party subscription.

## Verification

- `pnpm check` with local Postgres and Redis; never point DB tests at runtime data.
- `test/ai-shopping.e2e-spec.ts` covers real row-lock concurrency, expiry, final
  credits, retries, stale attempts, ownership, and admission errors.
- `test/service-purchases.e2e-spec.ts` covers ledger holds, duplicate orders,
  uncertain outcomes, requery, changed quotes/beneficiaries, and free reminders.
- Unit tests cover bounded tools, unknown offers/tools, merchant URL boundaries,
  deadlines, response codes, and callback trust boundaries.
- Flutter chat tests cover credit blocking/recovery and rendering compatibility.

Provider references:
https://developers.openai.com/api/docs/guides/function-calling
https://api-dashboard.search.brave.com/app/documentation/web-search
https://vtpass.com/documentation/authentication/
https://vtpass.com/documentation/response-codes/
https://vtpass.com/documentation/get-vtpass-wallet-balance/
