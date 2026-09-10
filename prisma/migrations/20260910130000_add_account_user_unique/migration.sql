-- A user can hold exactly one account (Wallet.accountId is already unique, so
-- the 1:1 wallet follows transitively).

-- Replace the plain userId index with a unique one.
DROP INDEX "accounts_user_id_idx";
CREATE UNIQUE INDEX "accounts_user_id_key" ON "accounts"("user_id");