CREATE TABLE "delivery_addresses" (
  "user_id" UUID NOT NULL,
  "street" VARCHAR(255) NOT NULL,
  "address_line_2" VARCHAR(255) NOT NULL,
  "city" VARCHAR(100) NOT NULL,
  "region" VARCHAR(100) NOT NULL,
  "country" VARCHAR(100) NOT NULL,
  "postal_code" VARCHAR(32) NOT NULL,
  CONSTRAINT "delivery_addresses_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "delivery_addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
