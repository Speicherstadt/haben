-- Ausgangsrechnungen aus dem Postfach (#660): Ablegen, Übernehmen und Verwerfen stehen mit Akteur im Audit-Log; wer eine Datei
-- verworfen hat, bleibt so nachvollziehbar. TRUNCATE gesperrt wie bei jeder Tabelle, deren Löschen das Audit-Log aufzeichnet.
CREATE TRIGGER inbox_outgoing_audit AFTER INSERT OR UPDATE OR DELETE ON inbox_outgoing
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
--> statement-breakpoint
CREATE TRIGGER inbox_outgoing_no_truncate BEFORE TRUNCATE ON inbox_outgoing
  FOR EACH STATEMENT EXECUTE FUNCTION haben_reject_truncate();
