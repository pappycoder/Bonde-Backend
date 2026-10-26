-- AlterTable
ALTER TABLE "cards" ALTER COLUMN "card_number_encrypted" DROP NOT NULL;

-- CreateTable
CREATE TABLE "finance_accounts" (
    "key" TEXT NOT NULL,
    "user_id" UUID,
    "currency" VARCHAR(3) NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "balance" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_accounts_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "finance_journals" (
    "transaction_id" BIGINT NOT NULL DEFAULT txid_current(),
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_entries" (
    "id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    "account_key" TEXT NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,

    CONSTRAINT "finance_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_operations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "fee" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "card_id" UUID,
    "provider_reference" TEXT,
    "request" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_customers" (
    "user_id" UUID NOT NULL,
    "sudo_id" TEXT,
    "bank_account_id" TEXT,
    "bank_account_number" TEXT,
    "bank_account_name" TEXT,
    "bank_code" TEXT,
    "identity_ref" TEXT,
    "identity_hash" TEXT,
    "bank_status" TEXT NOT NULL DEFAULT 'PENDING',
    "sudo_status" TEXT NOT NULL DEFAULT 'PENDING',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_customers_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "finance_authorizations" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "card_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "settled" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "refunded" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "released" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "merchant_name" TEXT NOT NULL,
    "mcc" TEXT NOT NULL,
    "response_code" TEXT NOT NULL,
    "approval_expires_at" TIMESTAMP(3),
    "approval_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_inbox" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_proofs" (
    "hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "finance_proofs_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "finance_installations" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_installations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "finance_accounts_user_id_currency_idx" ON "finance_accounts"("user_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "finance_journals_reference_key" ON "finance_journals"("reference");

-- CreateIndex
CREATE INDEX "finance_entries_account_key_idx" ON "finance_entries"("account_key");

-- CreateIndex
CREATE INDEX "finance_operations_status_created_at_idx" ON "finance_operations"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "finance_operations_user_id_idempotency_key_key" ON "finance_operations"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "finance_customers_sudo_id_key" ON "finance_customers"("sudo_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_customers_bank_account_id_key" ON "finance_customers"("bank_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_customers_bank_account_number_key" ON "finance_customers"("bank_account_number");

-- CreateIndex
CREATE INDEX "finance_authorizations_card_id_created_at_idx" ON "finance_authorizations"("card_id", "created_at");

-- CreateIndex
CREATE INDEX "finance_authorizations_user_id_status_idx" ON "finance_authorizations"("user_id", "status");

-- CreateIndex
CREATE INDEX "finance_inbox_status_created_at_idx" ON "finance_inbox"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "finance_inbox_provider_reference_key" ON "finance_inbox"("provider", "reference");

-- AddForeignKey
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_owner" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_entries" ADD CONSTRAINT "finance_entries_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "finance_journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_entries" ADD CONSTRAINT "finance_entries_account_key_fkey" FOREIGN KEY ("account_key") REFERENCES "finance_accounts"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_operations" ADD CONSTRAINT "finance_operation_owner" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_operations" ADD CONSTRAINT "finance_operations_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_customers" ADD CONSTRAINT "finance_customer_owner" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_authorizations" ADD CONSTRAINT "finance_authorization_owner" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_authorizations" ADD CONSTRAINT "finance_authorization_card" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Financial history is append-only, including for application-level mistakes.
CREATE FUNCTION finance_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial history is immutable'; END;
$$;
CREATE TRIGGER finance_entries_immutable BEFORE UPDATE OR DELETE ON finance_entries
FOR EACH ROW EXECUTE FUNCTION finance_history_immutable();
CREATE TRIGGER finance_journals_immutable BEFORE UPDATE OR DELETE ON finance_journals
FOR EACH ROW EXECUTE FUNCTION finance_history_immutable();

CREATE FUNCTION finance_check_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT COUNT(*) FROM finance_entries WHERE journal_id = NEW.id) < 2 OR EXISTS (
   SELECT a.currency FROM finance_entries e JOIN finance_accounts a ON a.key=e.account_key
   WHERE e.journal_id=NEW.id GROUP BY a.currency HAVING SUM(e.amount) <> 0
 ) THEN RAISE EXCEPTION 'Unbalanced financial journal'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_journal_balanced AFTER INSERT ON finance_journals
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance_check_journal();
ALTER TABLE finance_accounts ADD CONSTRAINT finance_user_balance_nonnegative CHECK (user_id IS NULL OR balance >= 0);
ALTER TABLE finance_accounts ADD CONSTRAINT finance_currency CHECK (currency IN ('NGN','USD'));

CREATE FUNCTION finance_entry_same_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM finance_journals WHERE id=NEW.journal_id AND transaction_id=txid_current())
 THEN RAISE EXCEPTION 'Cannot append to a posted journal'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER finance_entry_same_transaction BEFORE INSERT ON finance_entries
FOR EACH ROW EXECUTE FUNCTION finance_entry_same_transaction();

CREATE TRIGGER finance_installation_immutable BEFORE UPDATE OR DELETE ON finance_installations
FOR EACH ROW EXECUTE FUNCTION finance_history_immutable();
