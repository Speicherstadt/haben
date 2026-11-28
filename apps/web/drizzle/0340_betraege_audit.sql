-- Beträge eines Belegs, Positionen und Steuerzeilen einer Rechnung ins Audit-Log (#1978), wie document_splits (0129): Bisher
-- stand dort nur der Stand beim Festschreiben (im Siegel), Änderungen an Entwürfen gar nicht. Die Sperren vor dem Schreiben
-- (_locked, BEFORE) laufen weiter zuerst; eine abgelehnte Änderung schreibt also nichts ins Log. TRUNCATE sperren die
-- Trigger _no_truncate aus 0201 schon.
--
-- Nichts wird nachgetragen und an Daten, Sperren und Siegeln ändert sich nichts: Die Siegel lesen die Zeilen selbst, die
-- Integritätsprüfung gleicht aus dem Audit-Log nur die Einträge von seals ab. Zeilen von vorher stehen erst mit ihrer
-- nächsten Änderung im Log, als UPDATE oder DELETE mit altem Wert. invoice_taxes hat weder id noch year (Schlüssel
-- invoice_id, rate): haben_audit lässt row_id dort leer wie bei exchange_rates, der Schlüssel steht im Wert.
CREATE TRIGGER document_amounts_audit AFTER INSERT OR UPDATE OR DELETE ON document_amounts
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
--> statement-breakpoint
CREATE TRIGGER invoice_lines_audit AFTER INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
--> statement-breakpoint
CREATE TRIGGER invoice_taxes_audit AFTER INSERT OR UPDATE OR DELETE ON invoice_taxes
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
