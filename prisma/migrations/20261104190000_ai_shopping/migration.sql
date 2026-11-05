-- AlterTable
ALTER TABLE "ai_credit_accounts" ADD COLUMN     "ledger_initialized" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ai_credit_grants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_credit_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_credit_entries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "available_delta" INTEGER NOT NULL,
    "reserved_delta" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_credit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_chat_turns" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "request_key" TEXT NOT NULL,
    "message_id" UUID NOT NULL,
    "reply_id" UUID,
    "grant_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMP(3),
    "failure_code" TEXT,
    "usage" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_chat_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopping_results" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopping_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_quotes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "service_id" TEXT NOT NULL,
    "variation_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "beneficiary" TEXT NOT NULL,
    "beneficiary_name" TEXT,
    "phone" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "fee" DECIMAL(15,2) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_orders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "request_key" TEXT NOT NULL,
    "provider_reference" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMP(3),
    "provider_transaction_id" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_reminders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_credit_grants_source_key_key" ON "ai_credit_grants"("source_key");

-- CreateIndex
CREATE INDEX "ai_credit_grants_user_id_expires_at_idx" ON "ai_credit_grants"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_credit_entries_reference_key" ON "ai_credit_entries"("reference");

-- CreateIndex
CREATE INDEX "ai_credit_entries_user_id_created_at_idx" ON "ai_credit_entries"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_chat_turns_message_id_key" ON "ai_chat_turns"("message_id");

-- CreateIndex
CREATE INDEX "ai_chat_turns_status_lease_until_idx" ON "ai_chat_turns"("status", "lease_until");

-- CreateIndex
CREATE INDEX "ai_chat_turns_user_id_chat_id_idx" ON "ai_chat_turns"("user_id", "chat_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_chat_turns_user_id_request_key_key" ON "ai_chat_turns"("user_id", "request_key");

-- CreateIndex
CREATE INDEX "shopping_results_user_id_chat_id_idx" ON "shopping_results"("user_id", "chat_id");

-- CreateIndex
CREATE INDEX "service_quotes_user_id_created_at_idx" ON "service_quotes"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "service_orders_quote_id_key" ON "service_orders"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_orders_provider_reference_key" ON "service_orders"("provider_reference");

-- CreateIndex
CREATE INDEX "service_orders_status_updated_at_idx" ON "service_orders"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "service_orders_user_id_request_key_key" ON "service_orders"("user_id", "request_key");

-- CreateIndex
CREATE INDEX "service_reminders_status_due_at_idx" ON "service_reminders"("status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "service_reminders_order_id_due_at_key" ON "service_reminders"("order_id", "due_at");

-- AddForeignKey
ALTER TABLE "ai_credit_grants" ADD CONSTRAINT "ai_credit_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_credit_entries" ADD CONSTRAINT "ai_credit_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_credit_entries" ADD CONSTRAINT "ai_credit_entries_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "ai_credit_grants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chat_turns" ADD CONSTRAINT "ai_chat_turns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chat_turns" ADD CONSTRAINT "ai_chat_turns_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "ai_credit_grants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopping_results" ADD CONSTRAINT "shopping_results_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_quotes" ADD CONSTRAINT "service_quotes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "service_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_reminders" ADD CONSTRAINT "service_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_reminders" ADD CONSTRAINT "service_reminders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Credit accounting cannot be edited after recording an event.
ALTER TABLE ai_credit_grants ADD CONSTRAINT ai_credit_grant_nonnegative CHECK (units > 0 AND remaining >= 0 AND reserved >= 0 AND remaining + reserved <= units);
CREATE OR REPLACE FUNCTION protect_ai_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AI credit entries are immutable';
END;
$$;
CREATE TRIGGER ai_credit_entry_immutable BEFORE UPDATE OR DELETE ON ai_credit_entries FOR EACH ROW EXECUTE FUNCTION protect_ai_credit_entry();
ALTER TABLE ai_chat_turns ADD CONSTRAINT ai_turn_status CHECK (status IN ('RESERVED','RUNNING','COMPLETED','FAILED'));
ALTER TABLE service_orders ADD CONSTRAINT service_order_status CHECK (status IN ('QUEUED','PROCESSING','PENDING','SUCCEEDED','FAILED'));
ALTER TABLE service_quotes ADD CONSTRAINT service_quote_amount CHECK (amount > 0 AND fee >= 0);
CREATE INDEX ai_chat_turn_one_active_per_user ON ai_chat_turns(user_id) WHERE status IN ('RESERVED','RUNNING');
