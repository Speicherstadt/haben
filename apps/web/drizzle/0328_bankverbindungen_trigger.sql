-- Weitere Bankverbindungen (#1887): Rechnungen, Angebote und Kontakte verweisen darauf, darum nur archivieren, nicht
-- löschen. Änderungen ins Audit-Log, TRUNCATE gesperrt wie bei den übrigen Stammdaten.
CREATE FUNCTION haben_bankverbindungen_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Eine Bankverbindung wird nicht gelöscht, nur archiviert' USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bankverbindungen_guard BEFORE DELETE ON bankverbindungen
  FOR EACH ROW EXECUTE FUNCTION haben_bankverbindungen_guard();
--> statement-breakpoint
CREATE TRIGGER bankverbindungen_audit AFTER INSERT OR UPDATE OR DELETE ON bankverbindungen
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
--> statement-breakpoint
CREATE TRIGGER bankverbindungen_no_truncate BEFORE TRUNCATE ON bankverbindungen
  FOR EACH STATEMENT EXECUTE FUNCTION haben_reject_truncate();
