-- CreateTable
CREATE TABLE "card_history" (
    "id" UUID NOT NULL,
    "card_id" UUID NOT NULL,
    "event" VARCHAR(50) NOT NULL,
    "changes" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_merchants" (
    "id" UUID NOT NULL,
    "card_id" UUID NOT NULL,
    "merchant_name" VARCHAR(200) NOT NULL,
    "merchant_code" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_merchants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "card_history_card_id_created_at_idx" ON "card_history"("card_id", "created_at");

-- CreateIndex
CREATE INDEX "card_merchants_card_id_merchant_name_idx" ON "card_merchants"("card_id", "merchant_name");

-- CreateIndex
CREATE UNIQUE INDEX "card_merchants_card_id_merchant_code_key" ON "card_merchants"("card_id", "merchant_code");

-- AddForeignKey
ALTER TABLE "card_history" ADD CONSTRAINT "card_history_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_merchants" ADD CONSTRAINT "card_merchants_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
