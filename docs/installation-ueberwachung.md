---
title: "Überwachung mit Prometheus"
description: >-
  Metriken von Haben für Prometheus: Health, Hintergrundjobs wie Kontoabruf und Belegpostfach, ELSTER und Backup, mit
  Beispiel für Scrape-Konfiguration und Alarmregel.
---

# Überwachung mit Prometheus

Ob Haben antwortet, meldet [`/api/health`](installation.md#image). Ob der nächtliche Kontoabruf oder der Abruf des Belegpostfachs seit Tagen scheitert, zeigen die Metriken.

Mit gesetztem `HABEN_METRICS_TOKEN` ([Konfiguration](installation-konfiguration.md)) liefert `GET /api/metrics` Metriken im Textformat von [Prometheus](https://prometheus.io/docs/instrumenting/exposition_formats/). Ohne die Variable antwortet der Endpunkt mit `404`, ohne oder mit falschem Token mit `401`. Sitzungen und API-Tokens aus der Oberfläche gelten hier nicht, der Scraper bekommt so keinen Zugriff auf die Buchhaltung. Die Metriken zeigen nur, ob Haben läuft: keine Beträge, Namen, IBANs oder IDs.

| Metrik | Inhalt |
| --- | --- |
| `haben_info{version,commit}` | immer `1`, Version und Commit des Images |
| `haben_up` | `1`, wenn `/api/health` `pass` meldet, sonst `0` |
| `haben_job_last_run_timestamp_seconds{task}` | letzter Lauf eines Hintergrundjobs |
| `haben_job_last_success_timestamp_seconds{task}` | letzter erfolgreicher Lauf eines Hintergrundjobs |
| `haben_job_failures_total{task}` | gescheiterte Läufe, auch solche, die nur Fehler gemeldet haben, etwa eine abgelaufene Bankverbindung |
| `haben_elster_submissions_total{kind,result}` | Antworten von ERiC auf `validate` (Prüfen), `test` und `send`, nach `ok` oder `error` |
| `haben_backup_last_success_timestamp_seconds{kind}` | letztes gelungenes `backup` und letzter gelungener `restore_check` aus dem [Backup-Container](installation-backup.md) |

`task` ist einer von `recurring_invoices`, `archive_delivery`, `recurring_receipts`, `bank_duplicate_check`, `bank_sync`, `fints_sync`, `store_reports`, `etsy_sync`, `paypal_sync`, `stripe_sync`, `elster_mailbox`, `exchange_rates`, `base_rate`, `receipt_inbox`, `vat_id_check`, `deadline_mails`, `file_check` und `audit_checksum_mail`. Das Label heißt nicht `job`, weil Prometheus `job` schon für das Scrape-Ziel setzt. Jobs und ELSTER zählt Haben seit dem Start des Servers; nach einem Neustart fangen sie bei null an, die Zeitpunkte fehlen bis zum ersten Lauf (30 Sekunden nach dem Start, danach stündlich). Ein Job, der nichts zu tun hat, etwa ohne eingerichtetes Belegpostfach, gilt als erfolgreich.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: haben
    scheme: https
    authorization:
      credentials_file: /etc/prometheus/haben-metrics-token
    static_configs:
      - targets: ["haben.example.de"]
```

Eine Alarmregel für Jobs, die seit 24 Stunden nicht durchlaufen; die zweite fängt den Fall nach einem Neustart, in dem ein Job seitdem nie gelang:

```yaml
groups:
  - name: haben
    rules:
      - alert: HabenJobOhneErfolg
        expr: time() - haben_job_last_success_timestamp_seconds > 86400
      - alert: HabenJobOhneErfolg
        expr: haben_job_failures_total > 0 unless haben_job_last_success_timestamp_seconds
        for: 24h
```
