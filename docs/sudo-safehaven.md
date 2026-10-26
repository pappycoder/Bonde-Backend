# Sudo and Safe Haven finance

The implementation lives on `feat/sudo-safehaven-integration` in Backend, Mobile,
and Admin. Nothing here activates a provider account, deploys migrations to a
hosted database, or moves production money automatically.

## Responsibilities and money flow

Safe Haven provides verified NGN subaccounts, transfer lookup, name enquiry and
bank payouts. Sudo issues virtual cards using a gateway funding source. Bonde's
`finance_accounts`, journals and entries represent the customer liability and
its allocation. The older `wallets.balance` column is development data; it is
never imported as live money. Existing transaction rows are display projections,
not the source used to authorize payments.

A deposit is credited once after a server-side transfer query confirms the
receiving account, provider identity, amount and completed status. Configure
`SAFE_HAVEN_INCOMING_FEE_BEARER` from the verified contract: recipient fees are
deducted from credited funds; sender fees are not. The default `unknown` blocks
activation rather than guessing which side paid. A durable
SWEEP operation moves that asset to the configured treasury account; the sweep
does not credit the user again. Verify that your approved linked settlement
arrangement makes that treasury money available to Sudo. Do not count linked
Safe Haven and Sudo balance snapshots as independent assets.

Wallet available funds, card allocations and payment holds are different ledger
accounts. Allocation moves between them are balanced journals in one database
transaction. Authorization reserves the complete Sudo pending amount, including
provider fees. Capture consumes the hold without another wallet debit. Refunds,
reversals and closure release funds only after provider confirmation. Unmatched
fees, excess captures and uncertain outcomes enter the admin exception queue.
They never generate a guessed user debit.

Money commands require an operation-bound, single-use proof issued after the
server checks the user's passcode. Commands also require `Idempotency-Key`.
Network timeouts preserve reservations. Workers query existing provider records
instead of repeating a transfer or issuance POST. They can recover lost card or
transfer IDs using the original metadata/payment reference. Identity creation
can be reconciled by the admin using the original external reference.

Customer fees cannot exceed the confirmed payout quote. A lower confirmed fee
is returned automatically; an unexpected excess is recorded as a business
expense and an exception for investigation. Platform access subscriptions and
identity verification costs are business overhead. Configure contracted fees
before enabling the programme; zero example values are not advertised prices.

## Configure and validate the programme

1. Create Sudo and Safe Haven business accounts, complete their business
   verification, and obtain separate sandbox credentials first.
2. Apply migrations to a sandbox database using `pnpm prisma:deploy`. The
   migration adds new financial tables and makes stored encrypted card numbers
   optional. It does not reset or convert old balances or delete history.
3. Set the new variables in `.env.example`. For production use
   `https://api.sudo.cards`, `https://api.safehavenmfb.com`, and
   `FINANCE_ENVIRONMENT=production` together. Mixed environments are rejected.
   `PUBLIC_URL` must be the public HTTPS backend URL. Set `SAFE_HAVEN_ISSUER`
   to the Company URL registered for the Safe Haven OAuth application.
4. Configure Sudo gateway AND event callbacks at
   `PUBLIC_URL/api/finance/webhooks/sudo`, with the exact `SUDO_WEBHOOK_TOKEN`
   Authorization header. Use a gateway funding source with
   `jitGateway.authorizeByDefault=false`. Issuance checks the gateway settings.
5. Configure Safe Haven callbacks at
   `PUBLIC_URL/api/finance/webhooks/safe-haven`. If the programme supports a
   custom Authorization header, set `SAFE_HAVEN_WEBHOOK_TOKEN`. Every bank
   event is treated as a hint and verified through the authenticated transfer
   query API before funds are credited or a payout outcome is applied.
6. Start the supervised worker with `node scripts/finance-worker.mjs`, or run
   `node scripts/finance-worker.mjs --once` from a regular scheduler. It POSTs
   `/api/finance/jobs` using `Bearer FINANCE_JOB_TOKEN`. Configure
   `FINANCE_API_URL` separately on the worker. Do not expose this token in apps.
7. Validate receiving-account identity/OTP, treasury sweeps, settlement account
   coverage, fees, authorization timeouts, refunds, payout reversal and secure
   display against the actual sandbox programme. Confirm the provider's
   response shapes and callback environment labels. Customer records persist
   only provider references and keyed identity hashes, never raw identifiers.
8. Set `FINANCE_FEES_VERIFIED`, `FINANCE_TREASURY_VERIFIED`,
   `FINANCE_NGN_ENABLED` and `FINANCE_ENABLED` only after validation. Build the
   mobile app with `--dart-define=BONDE_LIVE_FINANCE=true`. Existing builds do
   not enter the live UI; their legacy financial writes are rejected by the
   backend in production. Roll out the matching mobile version before enabling
   live customer access.

Sudo card details use scoped, short-lived card tokens and Secure Proxy inside a
WebView, without PAN/CVV flowing through the backend, ordinary API responses,
analytics or native JavaScript channels. Validate the provider iframe origins
and device rendering with Sudo before production. The view closes on background
or after 90 seconds. No claim of blanket PCI compliance follows from using this
component; the deployed integration still needs the provider's validation.

## Interfaces

All paths below have the global `/api` prefix. Reads and financial commands are
scoped to the authenticated owner. Bank/API keys remain server-side.

- `GET /finance/capabilities`, `/overview`, `/cards`, `/merchants`, `/approvals`
- `POST /finance/identity/cardholder`, `/identity/bank/initiate`,
  `/identity/bank/complete`: transient identity data, followed by provider OTP.
- `GET /finance/banks`; `POST /finance/resolve-account`
- `POST /finance/quote`: command containing kind, currency, decimal-string
  amount and fee, plus its card/rule or recipient details.
- `POST /finance/proof`: `{command, passcode}` → `{proof, expiresAt}`
- `POST /finance/operations`: `{command, proof}` plus `Idempotency-Key` → an
  operation. Kinds: ISSUE, ALLOCATE, RETURN, WITHDRAW, RULES, PAUSE, RESUME,
  CANCEL, APPROVE and DECLINE.
- `GET /finance/operations`, `/operations/:id`, `/operation-key/:key`: retrieve
  the original outcome, including after a lost response.
- `POST /finance/cards/:id/display-session`: owner/passcode verification →
  scoped provider token and provider card ID, never raw credentials.
- `POST /finance/fx/quote` returns unavailable until the FX contract is verified.
- `GET /admin/finance`, `/admin/finance/liquidity`; POST `/admin/finance/reconcile`,
  `/admin/finance/inbox/:id/retry`, `/admin/finance/customers/:id/reconcile`.
  These reconcile provider evidence, not editable account balances.

Each command keeps its original request fingerprint. Reusing a key with a
changed payload fails. Mobile keeps a pending command and its key in encrypted
storage across crashes and lost responses. A pending action must be resolved
before starting a different financial command.

Rule evaluation uses exact provider merchant identifiers and conservative MCC
mappings. Merchant choices come from the user's verified card activity, not the
old bundled merchant names. Unknown mappings decline. Usage counts include
pending approved purchases; reversed holds release reserved capacity. Captured
purchases still consume their usage slot and gross budget after a refund. Months
reset at UTC calendar boundaries. A human approval grants one exact matching
merchant/card/currency/amount retry for five minutes; it cannot bypass hard rules,
card/account state or insufficient funds. No human or AI request blocks the
four-second authorization callback.

Sudo's documented canceled status requires a cancellation reason (`lost` or
`stolen`) and a credit account. The mobile closure flow asks for that reason;
ordinary temporary unavailability uses pause. Cards at a self-destruct usage
limit stop authorizing additional purchases; retain their records and outstanding
holds for settlement and refunds.

## Release boundary and operations

USD currency ledger accounts and UI availability are present, but USD card
issuance and FX are deliberately disabled in code. Setting
`FINANCE_USD_ENABLED=true` does not bypass this. Verified executable NGN→USD and
USD→NGN conversion, USD gateway rules, loading/unloading and refund behavior are
still required before implementing and enabling that programme. The public
USDNGN rate endpoint alone does not establish those contracts. Direct USD
receiving accounts, USD bank payouts, physical cards and ATM access are excluded.

Monitor UNKNOWN/PENDING age, failed sweeps, identity setups left PROCESSING,
REVIEW/RETRY inbox rows, authorization latency, provider settlement liquidity and
ledger projection mismatches. A worker cannot fix a provider contract discrepancy
by manufacturing a balance. Repeated unknown results without a uniquely matched
provider record remain blocked for investigation. No automated destructive
history cleanup exists. Test profiles and live profiles must remain separated.

Run `pnpm check`, Flutter analysis and the relevant Flutter tests, and Admin lint,
typecheck and build before rollout. SQL assertions in
`test/sql/finance-ledger.sql` require an isolated disposable database. They test
balanced commits, immutable history and nonnegative customer balances. Full
Prisma/API concurrency tests still require reachable local Postgres and Redis.
