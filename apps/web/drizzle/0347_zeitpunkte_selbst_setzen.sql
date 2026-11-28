-- Zeitpunkte von Einträgen im Audit-Log und von Siegeln setzen die Trigger selbst, statt sie den Standardwerten der
-- Spalten zu überlassen: Ein geänderter Standardwert von audit_log.at datierte sonst jeden neuen Eintrag zurück, ohne dass
-- die Kette bricht. at steht direkt vor dem Hash, damit es für jeden Eintrag gilt.
CREATE OR REPLACE FUNCTION haben_audit_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last audit_log;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Änderungen mit Eintrag im Audit-Log nur unter READ COMMITTED, sonst verzweigt die Hash-Kette'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('haben.audit_chain'));
  SELECT * INTO last FROM audit_log ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last.seq, 0) + 1;
  NEW.prev_hash := coalesce(last.row_hash, haben_audit_genesis());
  NEW.at := now();
  NEW.row_hash := haben_audit_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION haben_seal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cols jsonb := haben_seal_columns(TG_TABLE_NAME);
BEGIN
  INSERT INTO seals (table_name, row_id, columns, digest, genesis, created_at)
  VALUES (TG_TABLE_NAME, NEW.id, cols, haben_seal_digest(TG_TABLE_NAME, NEW.id, cols), false, now());
  RETURN NULL;
END;
$$;
