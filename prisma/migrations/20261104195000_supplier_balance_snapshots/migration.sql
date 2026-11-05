-- CreateTable
CREATE TABLE "supplier_balance_snapshots" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "balance" DECIMAL(20,6) NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_balance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_balance_snapshots_provider_environment_observed_at_idx" ON "supplier_balance_snapshots"("provider", "environment", "observed_at");

