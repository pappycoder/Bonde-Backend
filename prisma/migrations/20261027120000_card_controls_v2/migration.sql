-- AlterTable
ALTER TABLE "cards" ADD COLUMN     "control_expires_at" TIMESTAMP(3),
ADD COLUMN     "provider_lease_owner" TEXT,
ADD COLUMN     "provider_lease_until" TIMESTAMP(3),
ADD COLUMN     "retired_at" TIMESTAMP(3),
ADD COLUMN     "retirement_reason" TEXT,
ADD COLUMN     "retirement_status" TEXT,
ADD COLUMN     "rules_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "finance_authorizations" ADD COLUMN     "merchant_identity_id" UUID,
ADD COLUMN     "request_type" TEXT NOT NULL DEFAULT 'PURCHASE';

-- AlterTable
ALTER TABLE "finance_inbox" ADD COLUMN     "card_id" UUID;

-- CreateTable
CREATE TABLE "finance_merchant_identities" (
    "id" UUID NOT NULL,
    "environment" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mcc" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_merchant_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_merchant_access" (
    "user_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,

    CONSTRAINT "finance_merchant_access_pkey" PRIMARY KEY ("user_id","identity_id")
);

-- CreateTable
CREATE TABLE "finance_merchant_catalog" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "website" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "identity_ids" UUID[],
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_merchant_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_merchant_enrollments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "card_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "rules_version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_merchant_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_merchant_candidates" (
    "id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "authorization_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_merchant_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_captures" (
    "id" UUID NOT NULL,
    "provider_reference" TEXT NOT NULL,
    "journal_id" UUID NOT NULL,
    "authorization_id" TEXT NOT NULL,
    "card_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "is_purchase" BOOLEAN NOT NULL DEFAULT true,
    "booked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_captures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "finance_merchant_identities_environment_merchant_id_country_key" ON "finance_merchant_identities"("environment", "merchant_id", "country");

-- CreateIndex
CREATE INDEX "finance_merchant_enrollments_card_id_status_expires_at_idx" ON "finance_merchant_enrollments"("card_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "finance_merchant_candidates_enrollment_id_authorization_id_key" ON "finance_merchant_candidates"("enrollment_id", "authorization_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_captures_provider_reference_key" ON "finance_captures"("provider_reference");

-- CreateIndex
CREATE UNIQUE INDEX "finance_captures_journal_id_key" ON "finance_captures"("journal_id");

-- CreateIndex
CREATE INDEX "finance_captures_card_id_booked_at_idx" ON "finance_captures"("card_id", "booked_at");

-- AddForeignKey
ALTER TABLE "finance_merchant_access" ADD CONSTRAINT "finance_merchant_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_merchant_access" ADD CONSTRAINT "finance_merchant_access_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "finance_merchant_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_merchant_enrollments" ADD CONSTRAINT "finance_merchant_enrollments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_merchant_enrollments" ADD CONSTRAINT "finance_merchant_enrollments_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_merchant_candidates" ADD CONSTRAINT "finance_merchant_candidates_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "finance_merchant_enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_merchant_candidates" ADD CONSTRAINT "finance_merchant_candidates_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "finance_merchant_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_merchant_candidates" ADD CONSTRAINT "finance_merchant_candidates_authorization_id_fkey" FOREIGN KEY ("authorization_id") REFERENCES "finance_authorizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_captures" ADD CONSTRAINT "finance_captures_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "finance_journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_captures" ADD CONSTRAINT "finance_captures_authorization_id_fkey" FOREIGN KEY ("authorization_id") REFERENCES "finance_authorizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_captures" ADD CONSTRAINT "finance_captures_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_captures" ADD CONSTRAINT "finance_captures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Preserve booked settlement history; refunds never erase gross spending or completed uses.
INSERT INTO finance_captures (id,provider_reference,journal_id,authorization_id,card_id,user_id,currency,amount,is_purchase,booked_at)
SELECT j.id,j.reference,j.id,a.id,a.card_id,a.user_id,a.currency,-SUM(e.amount),true,j.created_at
FROM finance_journals j
JOIN finance_entries e ON e.journal_id=j.id AND e.amount<0
JOIN finance_authorizations a ON e.account_key='hold:'||a.id||':'||a.currency
WHERE j.reference LIKE 'sudo:transaction.created:%'
GROUP BY j.id,a.id
HAVING -SUM(e.amount)>0;

UPDATE finance_authorizations SET status='APPROVAL_USED' WHERE status='RETRY_USED';
-- Legacy MID-only bindings have no verified country/environment. Require explicit reconfirmation.
UPDATE card_locks SET config=(config-'merchantIds')||jsonb_build_object('merchantIds','[]'::jsonb,'pendingMerchantLabel','Confirm your merchant selection')
WHERE lock_type='MERCHANT';
UPDATE cards c SET control_expires_at=(l.config->>'end')::timestamptz
FROM card_locks l WHERE l.card_id=c.id AND l.lock_type='TIME' AND l.is_active=true
AND l.config->>'end' ~ '^\d{4}-\d{2}-\d{2}T';
UPDATE cards SET retired_at=CURRENT_TIMESTAMP,retirement_reason='TIME_EXPIRED',retirement_status='RETIRING'
WHERE issuer='sudo' AND status<>'CANCELLED' AND (expiration_date<=CURRENT_TIMESTAMP OR control_expires_at<=CURRENT_TIMESTAMP);
UPDATE cards c SET retired_at=CURRENT_TIMESTAMP,retirement_reason='USAGE_LIMIT',retirement_status='RETIRING'
FROM card_locks l WHERE c.id=l.card_id AND c.issuer='sudo' AND c.status<>'CANCELLED' AND c.retired_at IS NULL
AND l.lock_type='SELF_DESTRUCT' AND l.is_active=true AND l.config->>'usageLimit' ~ '^\d+$'
AND (SELECT COUNT(DISTINCT authorization_id) FROM finance_captures WHERE card_id=c.id AND is_purchase=true)>=(l.config->>'usageLimit')::integer;

UPDATE cards SET retired_at=CURRENT_TIMESTAMP,retirement_reason='ISSUER_CLOSED',retirement_status='CLOSED'
WHERE issuer='sudo' AND status='CANCELLED' AND retired_at IS NULL;

ALTER TABLE cards ADD CONSTRAINT cards_retirement_consistent CHECK ((retired_at IS NULL)=(retirement_reason IS NULL));
ALTER TABLE finance_captures ADD CONSTRAINT finance_captures_positive CHECK (amount>0);
CREATE FUNCTION guard_card_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at OR NEW.retirement_reason IS DISTINCT FROM OLD.retirement_reason) THEN
    RAISE EXCEPTION 'Permanent card retirement cannot be reversed';
  END IF;
  IF NEW.creation_lock_type IS DISTINCT FROM OLD.creation_lock_type THEN RAISE EXCEPTION 'Card type is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cards_retirement_monotonic BEFORE UPDATE ON cards FOR EACH ROW EXECUTE FUNCTION guard_card_retirement();
CREATE FUNCTION guard_finance_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Booked card captures are immutable'; END $$;
CREATE TRIGGER finance_capture_immutable BEFORE UPDATE OR DELETE ON finance_captures FOR EACH ROW EXECUTE FUNCTION guard_finance_capture();
CREATE INDEX finance_inbox_card_status_idx ON finance_inbox(card_id,status);

-- Candidate evidence and the identity keys used in card snapshots cannot drift.
CREATE FUNCTION guard_merchant_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Verified merchant evidence is immutable'; END $$;
CREATE TRIGGER merchant_candidate_immutable BEFORE UPDATE OR DELETE ON finance_merchant_candidates FOR EACH ROW EXECUTE FUNCTION guard_merchant_candidate();
CREATE FUNCTION guard_merchant_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.environment,NEW.merchant_id,NEW.country,NEW.name,NEW.mcc) IS DISTINCT FROM (OLD.environment,OLD.merchant_id,OLD.country,OLD.name,OLD.mcc) THEN
    RAISE EXCEPTION 'Verified merchant identity keys are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER merchant_identity_immutable BEFORE UPDATE ON finance_merchant_identities FOR EACH ROW EXECUTE FUNCTION guard_merchant_identity();
