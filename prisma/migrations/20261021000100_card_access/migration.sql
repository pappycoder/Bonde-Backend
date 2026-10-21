ALTER TABLE "profiles" ADD COLUMN "card_plan" VARCHAR(16) NOT NULL DEFAULT 'FREE',
ADD COLUMN "card_plan_expires_at" TIMESTAMP(3);
ALTER TABLE "cards" ADD COLUMN "creation_lock_type" "LockType";
