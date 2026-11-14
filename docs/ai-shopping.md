# AI shopping and service purchases

For provider token usage, per-user credit balances, funding estimates and admin
email alerts, see [Admin AI monitoring](ai-monitoring.md).

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

AI is disabled by default. For real AI replies set `AI_SHOPPING_ENABLED=true`
and `OPENAI_API_KEY`. The model defaults to `gpt-6-luna` with reasoning `none`;
`OPENAI_SHOPPING_MODEL` is an optional override. No OpenAI SDK dependency is needed.

Brave is the separate web search engine for current product links. It is not
needed for model replies or data/TV plans. For live product discovery set
`BRAVE_SEARCH_API_KEY` and `SHOPPING_MERCHANT_HOSTS` (comma-separated official
hostnames, not URLs). Search activates automatically when both are present.
The retired `SHOPPING_SEARCH_ENABLED` flag has no effect. Without configuration,
the AI explains the limitation and can still clarify requests or use other tools.
Search links are filtered against the allowlist; snippets never verify prices or
stock. Goods use official merchant checkout in the app browser; there is no merchant ordering API.

In production, `AI_PRICING_APPROVED=true` remains required after reviewing measured
model/search costs and the commercial catalog. One successful chargeable assistant reply costs one credit, even if
it uses several model calls. Usage counters record actual calls and tokens.

See [advanced environment settings](environment-advanced.md) for overrides and
production controls. `.env.example` contains only the starter setup.

## Nigerian merchant coverage

The validated page-reader merchants are `jumia.com.ng`, `konga.com`, `slot.ng`,
`pointekonline.com` and `kara.com.ng`. Set the comma-separated
`SHOPPING_MERCHANT_HOSTS` allowlist as shown in `.env.example`; adding a merchant
is an explicit operator choice, not an automatic runtime default.

SLOT (`/products/...`) and Pointek (`/product/...`) use the normal product-link
reader. Kara uses flat product URLs; its additional discovery path accepts only
links from catalog `<article>` cards containing a product image, heading and
naira price. Editorial/category pages with price estimates are never offers.
Every discovered URL is still checked against the configured allowlist and must
lead to a complete item page.

A qualifying item needs its name, description, image, specifications, exact price
and currency, plus explicit in-stock or limited-stock evidence. Conflicting
prices, incomplete data and unavailable products are excluded. The assistant
compares the combined candidates and returns the best five qualifying matches;
it never pads the list to reach five. Item links open that specific product in
the in-app merchant browser, with final shipping and payment confirmed there.

Each configured merchant causes a separate Brave request (up to 20 search hits).
Page reads share the existing 30-second budget and a maximum of 40 attempts per
merchant, with three reads active at once. A failed merchant search is isolated:
other stores can still supply results. If the remaining stores supply no usable
items, the request reports a temporary search failure instead of claiming that
nothing exists. If all merchant searches fail, the provider failure is preserved.
Diagnostics log only the merchant hostname, stage, failure category and optional
HTTP status; no user query, URL parameters, provider error body or credentials.
Provider usage metering still counts every attempted Brave call.

SLOT, Pointek and Kara use public item-page metadata in this integration and need
no merchant API credentials. Existing Brave, model and hosting costs still apply.
Amazon and eBay are intentionally excluded from this phase and require separate
account/API onboarding before integration.

## Product search reuse and checkout

Before enabling live product discovery, confirm permission to retain API data for
both the cache and saved results. [Brave's current FAQ](https://api-dashboard.search.brave.com/documentation/resources/help-feedback)
says storage requires contacting their team. The allowance cost example below
assumes no savings from retaining or caching Brave data.

Complete searches with at least five results reuse Redis-cached results for
**30 minutes**. Partial merchant failures and result sets below five use a
**one-minute** cache, allowing quick recovery or a broader subsequent search. Keys include the
user, chat, normalized query and current merchant allowlist; raw queries are not
stored in cache keys. Successful empty results are cached for one minute. Errors that prevent a useful
search response are never cached. Concurrent identical requests within one backend process share
one provider load. Redis outages follow the existing fail-open behaviour and may
cause additional Brave calls; coalescing still works within the process.

`find_goods` has a required `refresh` boolean. Normal searches use `false`; an
explicit user request to update results uses `true`, bypasses the cache, and
replaces it on success. A failed refresh leaves any still-valid prior cached
results available, without caching the error. Two search-tool executions per reply
remain the maximum, whether those executions hit Redis or Brave.

For comparisons and checkout questions, the assistant uses `read_recent_goods`
to retrieve at most ten stored results owned by the current user and chat without
Brave. These can be historical, so original discovery times are preserved through
the optional `discoveredAt` response field. IDs are reused instead of creating new
evidence on cache hits. Every reused URL is rechecked against the current merchant
allowlist. Changing requirements or finding no relevant prior results can trigger
a normal search; requests for fresh information can trigger an explicit refresh.

Usage distinguishes `searches` (actual attempted Brave requests, including failures),
`searchExecutions` (invocations of `find_goods`), `cacheHits` (Redis hits), and
`coalescedSearches` (requests served by another in-flight load). Only the turn that
starts a provider request increments `searches`; a waiting turn increments
`coalescedSearches` instead.
AI-credit pricing is unchanged: a successful shopping comparison still uses one
reply credit even when no new Brave request is needed.

Physical goods retain `OFFICIAL_LINK` checkout: the mobile **View item in merchant browser**
button opens the individual product page inside the app. The buyer confirms final price, stock, delivery
and payment there. Search/cache tools never place orders or debit a wallet. Data/TV
purchases continue through Safe Haven's separate quote approval and passcode flow.

## Explicit live smoke test

To test only OpenAI clarification, live Brave product discovery and Redis reuse:

```bash
pnpm smoke:shopping --products-only
```

This mode needs the OpenAI key, Brave key, merchant hostnames and Redis. It disables
service tools and does not require Safe Haven credentials or a phone number.

To also test Safe Haven sandbox plans and quotes:

```bash
pnpm smoke:shopping --phone=08012345678 --service=mtn-data
```

Start Redis first (`docker compose up -d redis`). Use a Nigerian test number and
your own sandbox credentials. `--service` is optional;
the first available data network is used by default. This opt-in command makes paid
OpenAI and Brave calls, then reads real Safe Haven sandbox plans and prepares quotes.
It checks that repeating the exact product search hits real Redis without another
Brave request, retaining the same IDs and timestamps. It exercises the actual
agent, search and quote services with memory-only evidence
and quote persistence; it does not connect to the application database or charge
Bonde credits. Normal unit/e2e tests never call live providers.

The script rejects production Safe Haven configuration, blocks purchase/provider
money endpoints, and starts no workers. It reports per-check success/failure,
latency, model calls, token counts and search counts, without printing credentials
or phone numbers. Missing configuration fails before any provider call. A zero-result
search or unavailable sandbox plan is reported as a failed check, not fabricated.
This provider smoke test complements the DB-backed credit/hold/ownership e2e suites.

## AI credit allowances

New AI-credit accounts receive **10 one-time welcome credits**, with no monthly
reset. Premium costs **NGN6,000/month** and includes **100 credits per paid billing
period**, replacing the former 8,000-credit offer. A credit is one chargeable
assistant reply, not one model token. Top-up packs retain their existing quantities
and prices: 10/NGN5,000, 50/NGN6,000, 60/NGN6,500 and 70/NGN7,000.

Previously issued welcome, purchased and unexpired Premium credits are preserved.
The migration changes only the database default for new credit accounts; runtime
creation explicitly uses the same allowance. No account balance or grant is cut.
The billing catalog exposes `free.welcomeCredits`, and the summary exposes
`welcomeAllowance` so clients do not hardcode the offer. Actual balances remain
in `credits.welcome`, `credits.plan` and `credits.purchased`.

Unpaid orders on old terms must be cancelled and recreated; confirmation and
idempotent retries cannot charge for a stale offer. Successful purchases and their
receipts retain their original terms. A paid mandate on old Premium terms does not
authorize charging for fewer credits. On renewal due, the old mandate is paused
without a debit or replacement grant, with an audit and in-app notice. The summary
reports `renewalRequiresReview`; users review the current offer and explicitly
subscribe again after their existing period ends. Matching current mandates still
renew idempotently as before. Deploy the updated backend and mobile offer copy
together, and retire older billing writers before changing the catalog.

These are conservative starting allowances, not a profit guarantee. At an
illustrative NGN1,500/USD, 10,000 input plus 1,000 output tokens across a reply and
two fresh Brave requests cost about NGN17.25 at the referenced standard rates.
One hundred such replies cost about NGN1,725, leaving NGN4,275 of the subscription
price for hosting, payment/card fees, support, taxes and other costs. Longer
contexts and provider rates can change this estimate. No free-provider subsidy or
Brave caching savings are assumed. Measure actual usage and all operating costs
before approving production pricing.

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

## Safe Haven sandbox and money lifecycle

Use the existing Safe Haven OAuth credentials (`SAFE_HAVEN_CLIENT_ID`,
`SAFE_HAVEN_ISSUER`, `SAFE_HAVEN_PRIVATE_KEY`). Set `SERVICE_PURCHASES_ENABLED=true`
and keep `FINANCE_ENVIRONMENT=sandbox` for plans, verification and quotes. Defaults
use `https://api.sandbox.safehavenmfb.com`. No VTpass credentials are needed.

Services/categories are discovered from `/vas/services` and their category endpoints.
Only available DSTV, GOTV, STARTIMES, MTN, GLO, AIRTEL and ETISALAT/9mobile categories
are mapped to Bonde's existing service IDs. Fixed-price products provide the native
bundle codes and prices. Unsupported, missing and variable-price products are not
replaced with samples. Cable accounts use `/vas/verify`; data numbers receive only
format validation, never a claim of provider-verified identity.

Quotes persist provider/environment/category/bundle identity in their immutable
fingerprint. The existing five-minute quote and two-minute passcode-proof windows,
owner checks, one-time proof consumption and wallet holds remain. Changed native
identifiers, prices or verified beneficiaries require a fresh quote.

Purchase submission additionally requires `FINANCE_TREASURY_ACCOUNT_NUMBER`.
The adapter checks its NGN supplier liquidity before reserving customer funds;
treasury liquidity is never credited to customer wallets. A worker submits once
with its persisted `externalReference`, then queries `/vas/transaction/{reference}`.
Restart recovery only requeries, never reposts an uncertain order. Authenticated
lookup evidence must match reference, amount, beneficiary and category to settle.
Unknown outcomes retain holds; failed vends still debited by the supplier await a
confirmed reversal before returning customer funds. Polling needs no additional
callback credential. The retired VTpass callback route is no longer registered.

Production requires the production environment/base URL plus existing
`FINANCE_ENABLED`, `FINANCE_FEES_VERIFIED`, `FINANCE_TREASURY_VERIFIED` and
`FINANCE_JOB_TOKEN` controls. This change does not enable any production purchases.
Validate provider fees and treasury debit/reversal behaviour before setting them.

### Guarded VTpass cutover

Pause every service writer and keep the old release/credentials available.
Resolve every nonterminal VTpass order using the old worker and authenticated
requery. Do not manually release uncertain holds. The new migration takes table
locks and refuses to proceed while any nonterminal old order exists.

After it passes, deploy all new writers together. Existing quotes/orders are tagged
`VTPASS`; historical order environments, receipts and ledger entries are preserved.
Unused old quotes expire and cannot be executed with Safe Haven. Old receipts can
still be viewed; renewal requires choosing a current provider plan if its old code
is unavailable. New orders are explicitly tagged `SAFE_HAVEN`, and workers only
process their own provider/environment. Remove VTpass variables and dashboard
callback configuration only after successful cutover. Never roll an old writer back
onto a database containing new Safe Haven orders.

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
https://developers.openai.com/api/docs/models/gpt-6-luna
https://developers.openai.com/api/docs/guides/function-calling
https://api-dashboard.search.brave.com/app/documentation/web-search
https://safehavenmfb.readme.io/reference/vas-transactions
https://safehavenmfb.readme.io/reference/get-services
https://safehavenmfb.readme.io/reference/get-category-products
https://safehavenmfb.readme.io/reference/buy-a-data-bundle
https://safehavenmfb.readme.io/reference/purchase-a-cable-tv-subscription
https://safehavenmfb.readme.io/reference/get-vas-transaction
