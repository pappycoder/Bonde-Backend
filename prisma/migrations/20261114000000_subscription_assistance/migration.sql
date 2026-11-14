CREATE TABLE "subscription_reminders" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "message_id" UUID NOT NULL,
  "subscription_id" UUID NOT NULL,
  "service_id" TEXT NOT NULL,
  "country_code" VARCHAR(2) NOT NULL,
  "due_at" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "subscription_reminders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "subscription_reminders_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "subscription_reminders_service_check" CHECK ("service_id" IN ('netflix', 'spotify')),
  CONSTRAINT "subscription_reminders_status_check" CHECK ("status" IN ('SCHEDULED', 'SENT', 'CANCELLED'))
);
CREATE UNIQUE INDEX "subscription_reminders_user_id_message_id_subscription_id_key" ON "subscription_reminders"("user_id", "message_id", "subscription_id");
CREATE INDEX "subscription_reminders_status_due_at_idx" ON "subscription_reminders"("status", "due_at");
