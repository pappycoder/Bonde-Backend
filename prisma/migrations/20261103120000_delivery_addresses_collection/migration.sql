-- Convert delivery_addresses from one row per user (user_id PK) into a
-- per-user collection with recipient details, LGA, and a default flag.
ALTER TABLE "delivery_addresses"
  ADD COLUMN "id" UUID,
  ADD COLUMN "recipient_name" VARCHAR(100) NOT NULL DEFAULT '',
  ADD COLUMN "recipient_phone" VARCHAR(20) NOT NULL DEFAULT '',
  ADD COLUMN "lga" VARCHAR(100) NOT NULL DEFAULT '',
  ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "delivery_addresses" SET "id" = gen_random_uuid();

-- Legacy rows carried no recipient contact; inherit it from the owner's profile.
UPDATE "delivery_addresses" AS da
SET "recipient_name" = p.full_name,
    "recipient_phone" = COALESCE(p.phone, '')
FROM "profiles" AS p
WHERE p.id = da.user_id;

ALTER TABLE "delivery_addresses" DROP CONSTRAINT "delivery_addresses_pkey";
ALTER TABLE "delivery_addresses" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "delivery_addresses" ADD CONSTRAINT "delivery_addresses_pkey" PRIMARY KEY ("id");
CREATE INDEX "delivery_addresses_user_id_idx" ON "delivery_addresses"("user_id");
