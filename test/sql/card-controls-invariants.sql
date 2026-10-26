-- Run only against a disposable database with all migrations applied.
-- All fixtures roll back; no provider calls or actual money movement occur.
BEGIN;
INSERT INTO profiles(id,full_name,email,updated_at) VALUES('aaaaaaaa-1111-4111-8111-111111111111','Controls test','controls-test@example.invalid',NOW());
INSERT INTO card_providers(id,name,base_url,updated_at) VALUES('bbbbbbbb-1111-4111-8111-111111111111','Controls test','https://example.invalid',NOW());
INSERT INTO cards(id,user_id,provider_id,card_number_last4,issuer,creation_lock_type,expiration_type,expiration_date,updated_at)
VALUES('cccccccc-1111-4111-8111-111111111111','aaaaaaaa-1111-4111-8111-111111111111','bbbbbbbb-1111-4111-8111-111111111111','1234','sudo','MERCHANT','yearly',NOW()+INTERVAL '1 year',NOW());
UPDATE cards SET retired_at=NOW(),retirement_reason='USER_REQUESTED',retirement_status='RETIRING' WHERE id='cccccccc-1111-4111-8111-111111111111';
INSERT INTO finance_merchant_identities(id,environment,merchant_id,country,name,mcc) VALUES('dddddddd-1111-4111-8111-111111111111','sandbox','test-mid','NG','Controls store','5411');
INSERT INTO finance_authorizations(id,user_id,card_id,currency,amount,settled,status,merchant_id,merchant_name,mcc,response_code,updated_at)
VALUES('controls-test-authorization','aaaaaaaa-1111-4111-8111-111111111111','cccccccc-1111-4111-8111-111111111111','NGN',10,10,'SETTLED','test-mid','Controls store','5411','00',NOW());
INSERT INTO finance_accounts(key,user_id,currency,kind,balance,updated_at) VALUES('controls-hold','aaaaaaaa-1111-4111-8111-111111111111','NGN','HOLD',0,NOW()),('controls-clearing',NULL,'NGN','CLEARING',0,NOW());
INSERT INTO finance_journals(id,reference,description) VALUES('eeeeeeee-1111-4111-8111-111111111111','controls-test-reservation','Test reservation'),('eeeeeeee-2222-4222-8222-222222222222','controls-test-capture','Test capture');
INSERT INTO finance_entries(id,journal_id,account_key,amount) VALUES
(gen_random_uuid(),'eeeeeeee-1111-4111-8111-111111111111','controls-clearing',-10),
(gen_random_uuid(),'eeeeeeee-1111-4111-8111-111111111111','controls-hold',10),
(gen_random_uuid(),'eeeeeeee-2222-4222-8222-222222222222','controls-hold',-10),
(gen_random_uuid(),'eeeeeeee-2222-4222-8222-222222222222','controls-clearing',10);
INSERT INTO finance_captures(id,provider_reference,journal_id,authorization_id,card_id,user_id,currency,amount,is_purchase)
VALUES('ffffffff-1111-4111-8111-111111111111','controls-test-capture','eeeeeeee-2222-4222-8222-222222222222','controls-test-authorization','cccccccc-1111-4111-8111-111111111111','aaaaaaaa-1111-4111-8111-111111111111','NGN',10,true);
INSERT INTO finance_merchant_enrollments(id,user_id,card_id,label,rules_version,expires_at)
VALUES('99999999-1111-4111-8111-111111111111','aaaaaaaa-1111-4111-8111-111111111111','cccccccc-1111-4111-8111-111111111111','Controls store',1,NOW()+INTERVAL '10 minutes');
INSERT INTO finance_merchant_candidates(id,enrollment_id,identity_id,authorization_id,request_hash)
VALUES('99999999-2222-4222-8222-222222222222','99999999-1111-4111-8111-111111111111','dddddddd-1111-4111-8111-111111111111','controls-test-authorization','fixture');
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN
  BEGIN
    UPDATE cards SET retired_at=NULL,retirement_reason=NULL WHERE id='cccccccc-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'test failed: retirement could be cleared';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'Permanent card retirement cannot be reversed' THEN RAISE; END IF; END;
  BEGIN
    UPDATE cards SET creation_lock_type='CATEGORY' WHERE id='cccccccc-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'test failed: primary type could change';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'Card type is immutable' THEN RAISE; END IF; END;
  BEGIN
    UPDATE finance_merchant_identities SET country='US' WHERE id='dddddddd-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'test failed: merchant identity drift';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'Verified merchant identity keys are immutable' THEN RAISE; END IF; END;
  BEGIN
    UPDATE finance_merchant_candidates SET request_hash='changed' WHERE id='99999999-2222-4222-8222-222222222222';
    RAISE EXCEPTION 'test failed: candidate evidence changed';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'Verified merchant evidence is immutable' THEN RAISE; END IF; END;
  BEGIN
    DELETE FROM finance_captures WHERE id='ffffffff-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'test failed: completed usage could be erased';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'Booked card captures are immutable' THEN RAISE; END IF; END;
  RAISE NOTICE 'Card control database invariants passed';
END $$;
SELECT 'Card control database invariants passed' AS result;
ROLLBACK;

