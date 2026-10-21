ALTER TABLE "profiles" ADD COLUMN "preferences" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "billing_cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "ai_credit_accounts" (
 "user_id" UUID PRIMARY KEY REFERENCES "profiles"("id") ON DELETE CASCADE,
 "welcome_remaining" INTEGER NOT NULL DEFAULT 100,
 "plan_remaining" INTEGER NOT NULL DEFAULT 0,
 "plan_granted" INTEGER NOT NULL DEFAULT 0,
  "plan_used" INTEGER NOT NULL DEFAULT 0,
 "purchased_remaining" INTEGER NOT NULL DEFAULT 0,
 "period_end" TIMESTAMP(3), "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "billing_orders" (
 "id" UUID PRIMARY KEY, "user_id" UUID NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
 "idempotency_key" VARCHAR(64) NOT NULL, "kind" VARCHAR(20) NOT NULL,
 "product_id" VARCHAR(40) NOT NULL, "amount" DECIMAL(15,2) NOT NULL,
 "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN', "credits" INTEGER NOT NULL DEFAULT 0,
 "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING', "payment_method" VARCHAR(16) NOT NULL,
 "card_id" UUID, "transaction_id" UUID, "failure_reason" VARCHAR(255),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "billing_orders_user_id_idempotency_key_key" ON "billing_orders"("user_id", "idempotency_key");
CREATE UNIQUE INDEX "billing_orders_transaction_id_key" ON "billing_orders"("transaction_id");
CREATE INDEX "billing_orders_user_id_created_at_idx" ON "billing_orders"("user_id", "created_at");
ALTER TABLE "ai_credit_accounts" ADD CONSTRAINT "nonnegative_credits" CHECK (
 "welcome_remaining" >= 0 AND "plan_remaining" >= 0 AND "plan_granted" >= 0 AND "plan_used" >= 0 AND "purchased_remaining" >= 0);

ALTER TABLE "billing_orders" ADD CONSTRAINT "billing_positive_amount" CHECK ("amount" > 0 AND "credits" > 0);
