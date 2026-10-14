CREATE TABLE "withdrawal_bank_accounts" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "bank_code" VARCHAR(10) NOT NULL,
  "bank_name" VARCHAR(255) NOT NULL,
  "account_number" VARCHAR(10) NOT NULL,
  "account_name" VARCHAR(255) NOT NULL,
  "verified_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "withdrawal_bank_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "withdrawal_bank_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "withdrawal_bank_accounts_user_id_bank_code_account_number_key" ON "withdrawal_bank_accounts"("user_id", "bank_code", "account_number");
