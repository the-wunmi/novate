-- Ledger transfers and deal events are append-only: corrections are new reversing entries.
CREATE OR REPLACE FUNCTION novate_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_transfers_append_only
  BEFORE UPDATE OR DELETE ON ledger_transfers
  FOR EACH ROW EXECUTE FUNCTION novate_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER deal_events_append_only
  BEFORE UPDATE OR DELETE ON deal_events
  FOR EACH ROW EXECUTE FUNCTION novate_reject_mutation();
--> statement-breakpoint
-- A transfer must move money between two accounts of the same currency.
CREATE OR REPLACE FUNCTION novate_check_transfer_currency() RETURNS trigger AS $$
BEGIN
  IF (SELECT currency FROM ledger_accounts WHERE id = NEW.debit_account_id) <> NEW.currency
     OR (SELECT currency FROM ledger_accounts WHERE id = NEW.credit_account_id) <> NEW.currency THEN
    RAISE EXCEPTION 'currency mismatch on transfer %', NEW.idempotency_key;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_transfers_currency
  BEFORE INSERT ON ledger_transfers
  FOR EACH ROW EXECUTE FUNCTION novate_check_transfer_currency();
