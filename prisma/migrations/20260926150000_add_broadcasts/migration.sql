-- CreateTable
CREATE TABLE "broadcasts" (
    "id" UUID NOT NULL,
    "title" VARCHAR(140) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "recipient_count" INTEGER NOT NULL,
    "sent_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "broadcasts_created_at_idx" ON "broadcasts"("created_at");

-- AddForeignKey
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
