-- Model account_type as a Postgres enum. Existing rows store lowercase
-- 'checking'/'savings', so uppercase them before casting; the column default
-- moves from 'checking'::varchar to the 'CHECKING' enum member.

CREATE TYPE "AccountType" AS ENUM ('CHECKING', 'SAVINGS', 'BUSINESS');

UPDATE "accounts" SET "account_type" = UPPER("account_type");

ALTER TABLE "accounts"
  ALTER COLUMN "account_type" DROP DEFAULT,
  ALTER COLUMN "account_type" TYPE "AccountType"
    USING ("account_type"::"AccountType"),
  ALTER COLUMN "account_type" SET DEFAULT 'CHECKING';