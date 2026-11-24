# Advanced environment configuration

Start with `.env.example`. This reference is not loaded automatically; copy only
needed overrides into `.env`. Existing secrets are never rewritten.

## Optional defaults and overrides

Application URLs, rate limits, mail branding, Termii sender, legal URLs and separate
MFA/KYC keys have defaults in code. Firebase is optional: use inline service-account
JSON or a file path; without either, in-app notifications still work.

```dotenv
PUBLIC_URL=http://localhost:3001
ADMIN_APP_URL=http://localhost:3000
FIREBASE_SERVICE_ACCOUNT_JSON=
FIREBASE_SERVICE_ACCOUNT_PATH=
FIREBASE_PROJECT_ID=
THROTTLE_TTL=60000
THROTTLE_LIMIT=100
THROTTLE_STRICT_TTL=60000
THROTTLE_STRICT_LIMIT=5
THROTTLE_STRICT_BLOCK_DURATION=300000
THROTTLE_BLOCK_DURATION=0
MAIL_LOGO_URL=
MAIL_ASSET_BASE_URL=
TERMII_SENDER_ID=Bonde
# MFA_ENCRYPTION_KEY=<optional separate 64-character hex key>
PROFILE_BILLING_ENABLED=true
TERMS_URL=https://www.usebonde.com
PRIVACY_URL=https://www.usebonde.com
SUBSCRIPTION_TERMS_URL=https://www.usebonde.com
FINANCE_NGN_ENABLED=false
FINANCE_USD_ENABLED=false
FINANCE_FEES_VERIFIED=false
FINANCE_TREASURY_VERIFIED=false
SUDO_BASE_URL=https://api.sandbox.sudo.cards
SUDO_API_KEY=
SUDO_BUSINESS_ID=
SUDO_WEBHOOK_TOKEN=
SUDO_NGN_FUNDING_SOURCE_ID=
SUDO_NGN_SETTLEMENT_ID=
SUDO_NGN_BRAND=Verve
SUDO_NGN_ISSUE_FEE=0.00
SUDO_USD_FUNDING_SOURCE_ID=
SUDO_USD_SETTLEMENT_ID=
SUDO_USD_BRAND=MasterCard
SUDO_USD_ISSUE_FEE=0.00
SAFE_HAVEN_BASE_URL=https://api.sandbox.safehavenmfb.com
SAFE_HAVEN_WEBHOOK_TOKEN=
SAFE_HAVEN_BANK_CODE=
SAFE_HAVEN_WITHDRAWAL_FEE=0.00
SAFE_HAVEN_INCOMING_FEE_BEARER=unknown
FINANCE_JOB_TOKEN=
FINANCE_API_URL=http://127.0.0.1:3001
AI_PRICING_APPROVED=false
OPENAI_SHOPPING_MODEL=gpt-6-luna
SERVICE_PURCHASE_FEE=0.00
```

`OPENAI_SHOPPING_MODEL` defaults to `gpt-6-luna`; requests use reasoning `none`.
Production AI additionally requires `AI_PRICING_APPROVED=true` after cost review.

Brave search needs its key and an explicit comma-separated list of official merchant
hostnames. Missing either disables the search tool while other AI flows still work.
`SHOPPING_SEARCH_ENABLED` is obsolete; remove it from deployment settings.

## Finance and production

Safe Haven plans, verification and quotes use `SERVICE_PURCHASES_ENABLED=true`
and the existing Safe Haven credentials. Purchase submission additionally needs
`FINANCE_TREASURY_ACCOUNT_NUMBER`. Its balance is observed as supplier liquidity,
never added to customer wallets.

Sandbox is the default. For production set `FINANCE_ENVIRONMENT=production` and
`SAFE_HAVEN_BASE_URL=https://api.safehavenmfb.com`. Live bill submission additionally
requires `FINANCE_ENABLED`, `FINANCE_FEES_VERIFIED`, `FINANCE_TREASURY_VERIFIED` and
`FINANCE_JOB_TOKEN`. Sudo/card prerequisites remain as documented in
[sudo-safehaven.md](sudo-safehaven.md). USD remains disabled in code.

Keep all purchase/finance switches false during initial AI testing; the explicit
smoke command enables sandbox read/quote capabilities only within its process.
See [AI shopping](ai-shopping.md) for smoke usage and the guarded VTpass cutover.

VTpass credentials and flags are obsolete after cutover. Resolve every old
nonterminal order using the old release before deploying the migration; then remove
its credentials and callback configuration. Historical orders and ledger entries remain.
