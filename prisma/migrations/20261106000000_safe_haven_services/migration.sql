-- Deploy with all service writers paused. Keep the old release until this guard passes.
BEGIN;
LOCK TABLE "service_orders", "service_quotes" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "service_orders" WHERE "status" NOT IN ('SUCCEEDED', 'FAILED')) THEN
    RAISE EXCEPTION 'Reconcile all VTpass service orders with the old release before Safe Haven cutover. Do not release uncertain holds manually.';
  END IF;
END $$;
ALTER TABLE "service_quotes" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'VTPASS',
 ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'sandbox',
 ADD COLUMN "provider_category_id" TEXT,
 ADD COLUMN "provider_plan_code" TEXT;
ALTER TABLE "service_orders" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'VTPASS';
UPDATE "service_quotes" q SET "environment" = o."environment"
 FROM "service_orders" o WHERE o."quote_id" = q."id";
-- Old unexecuted quotes cannot be approved with a different supplier.
UPDATE "service_quotes" q SET "expires_at" = LEAST("expires_at", NOW())
 WHERE NOT EXISTS (SELECT 1 FROM "service_orders" o WHERE o."quote_id" = q."id");
ALTER TABLE "service_quotes" ALTER COLUMN "provider" DROP DEFAULT,
 ALTER COLUMN "environment" DROP DEFAULT;
ALTER TABLE "service_orders" ALTER COLUMN "provider" DROP DEFAULT;
COMMIT;
