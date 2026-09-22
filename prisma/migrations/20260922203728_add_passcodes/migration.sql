-- CreateTable
CREATE TABLE "passcodes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "hash" VARCHAR(128) NOT NULL,
    "salt" VARCHAR(64) NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "passcodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "passcodes_user_id_key" ON "passcodes"("user_id");

-- AddForeignKey
ALTER TABLE "passcodes" ADD CONSTRAINT "passcodes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
