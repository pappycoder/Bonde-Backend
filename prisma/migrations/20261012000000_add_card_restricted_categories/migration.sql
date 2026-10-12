-- Extend the card restricted-category catalog. Additive enum values; existing
-- rows are untouched. Apply with `pnpm prisma:deploy` (or `prisma migrate dev`).
ALTER TYPE "CardRestrictedCategory" ADD VALUE 'GROCERIES';
ALTER TYPE "CardRestrictedCategory" ADD VALUE 'ENTERTAINMENT';
ALTER TYPE "CardRestrictedCategory" ADD VALUE 'SHOPPING';
ALTER TYPE "CardRestrictedCategory" ADD VALUE 'ELECTRICITY';
ALTER TYPE "CardRestrictedCategory" ADD VALUE 'DINING';
ALTER TYPE "CardRestrictedCategory" ADD VALUE 'TRAVEL';