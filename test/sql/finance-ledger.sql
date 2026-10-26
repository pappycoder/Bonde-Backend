-- Run only in an isolated disposable database after applying the schema.
BEGIN;
INSERT INTO profiles(id,full_name,email,updated_at) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Ledger test','ledger-test@example.invalid',NOW());
INSERT INTO finance_accounts(key,user_id,currency,kind,balance,updated_at) VALUES('test-wallet','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','NGN','WALLET',0,NOW()),('test-clearing',NULL,'NGN','CLEARING',0,NOW());
INSERT INTO finance_journals(id,reference,description) VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','test-balanced','test');
INSERT INTO finance_entries(id,journal_id,account_key,amount) VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','test-wallet',10),('dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','test-clearing',-10);
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN
 BEGIN
  UPDATE finance_entries SET amount=11 WHERE account_key='test-wallet';
  RAISE EXCEPTION 'test failed: history was editable';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'Financial history is immutable' THEN RAISE; END IF;
 END;
 BEGIN
  DELETE FROM finance_journals WHERE reference='test-balanced';
  RAISE EXCEPTION 'test failed: history was deletable';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'Financial history is immutable' THEN RAISE; END IF;
 END;
 BEGIN
  UPDATE finance_accounts SET balance=-1 WHERE key='test-wallet';
  RAISE EXCEPTION 'test failed: negative customer balance';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
SET CONSTRAINTS ALL DEFERRED;
DO $$ BEGIN
 BEGIN
  INSERT INTO finance_journals(id,reference,description) VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','test-unbalanced','test');
  INSERT INTO finance_entries(id,journal_id,account_key,amount) VALUES('ffffffff-ffff-4fff-8fff-ffffffffffff','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','test-wallet',10),('99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','test-clearing',-9);
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'test failed: unbalanced journal accepted';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'Unbalanced financial journal' THEN RAISE; END IF;
 END;
END $$;
COMMIT;
BEGIN;
DO $$ BEGIN
 BEGIN
  INSERT INTO finance_entries(id,journal_id,account_key,amount) VALUES('12121212-1212-4212-8212-121212121212','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','test-wallet',1);
  RAISE EXCEPTION 'test failed: appended to a committed journal';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'Cannot append to a posted journal' THEN RAISE; END IF;
 END;
END $$;
ROLLBACK;
SELECT 'finance ledger SQL assertions passed' AS result;
