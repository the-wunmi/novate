DROP TABLE "approvals" CASCADE;--> statement-breakpoint
CREATE TRIGGER decision_records_append_only
  BEFORE UPDATE OR DELETE ON decision_records
  FOR EACH ROW EXECUTE FUNCTION novate_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER deal_facts_append_only
  BEFORE UPDATE OR DELETE ON deal_facts
  FOR EACH ROW EXECUTE FUNCTION novate_reject_mutation();
