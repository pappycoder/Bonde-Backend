-- Add email to profiles, mirroring supabase.auth.users.email for app-side lookups.
-- The column is NOT NULL because every row mirrors an existing auth.users row.
ALTER TABLE "profiles" ADD COLUMN "email" VARCHAR(254) NOT NULL;

CREATE UNIQUE INDEX "profiles_email_key" ON "profiles"("email");