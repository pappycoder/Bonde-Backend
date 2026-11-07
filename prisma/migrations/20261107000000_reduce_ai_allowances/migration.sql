-- Only new accounts receive the smaller trial. Issued grants and balances remain intact.
ALTER TABLE "ai_credit_accounts" ALTER COLUMN "welcome_remaining" SET DEFAULT 10;
