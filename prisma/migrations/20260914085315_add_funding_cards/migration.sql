-- CreateEnum
CREATE TYPE "VirtualAccountStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ProviderEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'DUPLICATE', 'FAILED');

-- AlterTable
ALTER TABLE "cards" ADD COLUMN     "balance" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "card_cvv_encrypted" TEXT,
ADD COLUMN     "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN',
ADD COLUMN     "issuer" VARCHAR(20) NOT NULL DEFAULT 'bonde',
ADD COLUMN     "last_sync_at" TIMESTAMP(3),
ADD COLUMN     "name_on_card" VARCHAR(100);

-- CreateTable
CREATE TABLE "virtual_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(50) NOT NULL DEFAULT 'flutterwave',
    "provider_reference" VARCHAR(255) NOT NULL,
    "tx_ref" VARCHAR(100) NOT NULL,
    "account_number" VARCHAR(20) NOT NULL,
    "bank_name" VARCHAR(100) NOT NULL,
    "account_name" VARCHAR(100),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN',
    "status" "VirtualAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_permanent" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3),
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virtual_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "reference" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "status" "ProviderEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "transaction_id" UUID,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "virtual_accounts_user_id_key" ON "virtual_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_accounts_tx_ref_key" ON "virtual_accounts"("tx_ref");

-- CreateIndex
CREATE INDEX "virtual_accounts_tx_ref_idx" ON "virtual_accounts"("tx_ref");

-- CreateIndex
CREATE INDEX "provider_events_transaction_id_idx" ON "provider_events"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_events_provider_reference_key" ON "provider_events"("provider", "reference");

-- AddForeignKey
ALTER TABLE "virtual_accounts" ADD CONSTRAINT "virtual_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
