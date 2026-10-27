ALTER TABLE "waitlist_signups"
  ALTER COLUMN "name" TYPE VARCHAR(511),
  ADD COLUMN "first_name" VARCHAR(255),
  ADD COLUMN "last_name" VARCHAR(255),
  ADD COLUMN "phone" VARCHAR(16);
