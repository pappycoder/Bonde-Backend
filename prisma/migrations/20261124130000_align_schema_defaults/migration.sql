-- Align the committed Prisma model without deleting or rewriting application data.
-- Preserve financial records, indexes, and existing delivery addresses.
BEGIN;

-- DropForeignKey
ALTER TABLE "ai_credit_accounts" DROP CONSTRAINT "ai_credit_accounts_user_id_fkey";

-- DropForeignKey
ALTER TABLE "billing_orders" DROP CONSTRAINT "billing_orders_user_id_fkey";

-- AlterTable
ALTER TABLE "delivery_addresses" ALTER COLUMN "recipient_name" DROP DEFAULT,
ALTER COLUMN "recipient_phone" DROP DEFAULT,
ALTER COLUMN "lga" DROP DEFAULT,
ALTER COLUMN "is_default" SET DEFAULT false,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "ai_credit_accounts" ADD CONSTRAINT "ai_credit_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_orders" ADD CONSTRAINT "billing_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
