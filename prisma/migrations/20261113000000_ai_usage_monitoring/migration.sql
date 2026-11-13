-- CreateTable
CREATE TABLE "ai_usage_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "http_status" INTEGER,
    "input_tokens" INTEGER,
    "cached_input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "reasoning_tokens" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "cost_usd" DECIMAL(20,10),
    "rate_id" UUID,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_rates" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "input_per_million" DECIMAL(20,8) NOT NULL,
    "cached_input_per_million" DECIMAL(20,8) NOT NULL,
    "output_per_million" DECIMAL(20,8) NOT NULL,
    "search_per_thousand" DECIMAL(20,8) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "ai_usage_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_provider_accounts" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "baseline_at" TIMESTAMP(3),
    "threshold_base_usd" DECIMAL(20,10),
    "cycle_id" UUID NOT NULL,
    "warning_percent" INTEGER NOT NULL DEFAULT 20,
    "critical_percent" INTEGER NOT NULL DEFAULT 10,
    "email_recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_provider_funding" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "reference" UUID NOT NULL,
    "amount_usd" DECIMAL(20,8) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "note" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "ai_provider_funding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_alerts" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "cycle_id" UUID NOT NULL,
    "severity" VARCHAR(16) NOT NULL,
    "remaining_usd" DECIMAL(20,10) NOT NULL,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sent_to" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "email_attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMP(3),
    "email_complete" BOOLEAN NOT NULL DEFAULT false,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_events_provider_occurred_at_idx" ON "ai_usage_events"("provider", "occurred_at");

-- CreateIndex
CREATE INDEX "ai_usage_events_user_id_occurred_at_idx" ON "ai_usage_events"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "ai_usage_rates_provider_model_created_at_idx" ON "ai_usage_rates"("provider", "model", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_accounts_provider_key" ON "ai_provider_accounts"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_funding_reference_key" ON "ai_provider_funding"("reference");

-- CreateIndex
CREATE INDEX "ai_provider_funding_provider_created_at_idx" ON "ai_provider_funding"("provider", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_alerts_email_complete_next_attempt_at_idx" ON "ai_usage_alerts"("email_complete", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_alerts_provider_cycle_id_severity_key" ON "ai_usage_alerts"("provider", "cycle_id", "severity");

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_rate_id_fkey" FOREIGN KEY ("rate_id") REFERENCES "ai_usage_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- These operational records are available only through the server's admin API.
ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_provider_funding ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_events ADD CONSTRAINT ai_usage_provider CHECK (provider IN ('OPENAI','BRAVE'));
ALTER TABLE ai_usage_events ADD CONSTRAINT ai_usage_status CHECK (status IN ('PENDING','SUCCESS','HTTP_ERROR','UNKNOWN'));
ALTER TABLE ai_usage_events ADD CONSTRAINT ai_usage_nonnegative CHECK (input_tokens>=0 AND cached_input_tokens>=0 AND output_tokens>=0 AND reasoning_tokens>=0 AND duration_ms>=0 AND cost_usd>=0 AND cached_input_tokens<=input_tokens AND reasoning_tokens<=output_tokens);
ALTER TABLE ai_usage_rates ADD CONSTRAINT ai_rate_values CHECK (provider IN ('OPENAI','BRAVE') AND input_per_million>=0 AND cached_input_per_million>=0 AND output_per_million>=0 AND search_per_thousand>=0);
ALTER TABLE ai_provider_accounts ADD CONSTRAINT ai_account_thresholds CHECK (provider IN ('OPENAI','BRAVE') AND critical_percent>=0 AND critical_percent<warning_percent AND warning_percent<100 AND threshold_base_usd>=0);
ALTER TABLE ai_provider_funding ADD CONSTRAINT ai_funding_values CHECK (provider IN ('OPENAI','BRAVE') AND ((kind IN ('OPENING','BALANCE') AND amount_usd>=0) OR (kind='TOP_UP' AND amount_usd>0)));
ALTER TABLE ai_usage_alerts ADD CONSTRAINT ai_alert_values CHECK (provider IN ('OPENAI','BRAVE') AND severity IN ('WARNING','CRITICAL'));

CREATE FUNCTION protect_ai_monitor_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AI monitoring history is immutable';
END;
$$;
CREATE TRIGGER ai_rate_immutable BEFORE UPDATE OR DELETE ON ai_usage_rates FOR EACH ROW EXECUTE FUNCTION protect_ai_monitor_history();
CREATE TRIGGER ai_funding_immutable BEFORE UPDATE OR DELETE ON ai_provider_funding FOR EACH ROW EXECUTE FUNCTION protect_ai_monitor_history();
CREATE FUNCTION protect_ai_usage_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status<>'PENDING' THEN
    RAISE EXCEPTION 'Finalized AI usage receipts are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_usage_receipt_immutable BEFORE UPDATE OR DELETE ON ai_usage_events FOR EACH ROW EXECUTE FUNCTION protect_ai_usage_receipt();

