-- #1312: Rechnungen über § 4 UStG und Ausfuhr bekommen beim Festschreiben das Kennzeichen „leistung“ (Kz 48 bzw. 43 der
-- Voranmeldung auch bei Ist im Zeitraum der Leistung, Anzahlungen darauf nicht; Anleitung zur UStVA 2026). Leer heißt
-- bisherige Zuordnung; ein vergessener Schreibweg fiele sonst nie auf. Aus Lexoffice übernommene Rechnungen meldet die
-- Voranmeldung nicht und brauchen keins. Bereits festgeschriebene Zeilen trifft der Trigger nicht, sie bleiben durch
-- invoices_locked unverändert. Muster: invoices_reduction_rule (0295).
-- Entscheidung: https://github.com/Speicherstadt/haben/pull/1771 (Antwort 3: Übergang wie bei #1228)
CREATE FUNCTION haben_check_exempt_rule() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.exempt_rule IS NULL THEN
    RAISE EXCEPTION 'Rechnungen über steuerfreie Umsätze und Ausfuhrlieferungen brauchen beim Festschreiben das Kennzeichen der Zuordnung zur Leistung.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_exempt_rule BEFORE UPDATE OF locked_at ON invoices
  FOR EACH ROW WHEN (
    OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL AND NEW.kind = 'rechnung'
    AND NEW.tax_treatment IN ('steuerfrei', 'ausfuhr') AND NEW.lexoffice_voucher_id IS NULL
  ) EXECUTE FUNCTION haben_check_exempt_rule();
--> statement-breakpoint
CREATE TRIGGER invoices_exempt_rule_insert BEFORE INSERT ON invoices
  FOR EACH ROW WHEN (
    NEW.locked_at IS NOT NULL AND NEW.kind = 'rechnung'
    AND NEW.tax_treatment IN ('steuerfrei', 'ausfuhr') AND NEW.lexoffice_voucher_id IS NULL
  ) EXECUTE FUNCTION haben_check_exempt_rule();
