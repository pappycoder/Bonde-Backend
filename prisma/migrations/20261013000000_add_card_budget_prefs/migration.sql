-- Add budget-locked preferences to cards: top-up permission and the three
-- budget notification toggles. Additive boolean columns; existing rows default
-- to the "on" state. Apply with `pnpm prisma:deploy` (or `prisma migrate dev`).
ALTER TABLE "cards" ADD COLUMN "allow_top_up" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "cards" ADD COLUMN "notify_half_spent" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "cards" ADD COLUMN "notify_low_balance" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "cards" ADD COLUMN "notify_budget_reached" BOOLEAN NOT NULL DEFAULT true;
