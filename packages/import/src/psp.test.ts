import { describe, expect, it } from "vitest";
import { detectStatementFormat, parseStatement, withDedupHashes } from "./index.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const brief = (s: ReturnType<typeof parseStatement>) => s.transactions.map((t) => [t.bookingDate, t.amount, t.counterpartyName, t.purpose]);

describe("PayPal", () => {
  const german = [
    `"Datum","Uhrzeit","Zeitzone","Name","Typ","Status","Währung","Brutto","Gebühr","Netto","Absender E-Mail-Adresse","Empfänger E-Mail-Adresse","Transaktionscode","Rechnungsnummer","Guthaben"`,
    `"01.10.2026","10:15:00","CEST","Nordwerk Software GmbH","Website-Zahlung","Abgeschlossen","EUR","119,00","-2,61","116,39","a@b.example","shop@example.com","1AB23456CD789012E","RE-2026-041","116,39"`,
    `"02.10.2026","09:00:00","CEST","Kunde US","Website-Zahlung","Abgeschlossen","USD","50,00","-1,99","48,01","","","2XY","",""`,
    `"03.10.2026","11:00:00","CEST","Alpenblick","Website-Zahlung","Ausstehend","EUR","20,00","0,00","20,00","","","3ZZ","",""`,
    `"05.10.2026","08:00:00","CEST","DKB","Allgemeine Abbuchung","Abgeschlossen","EUR","-1.000,00","0,00","-1.000,00","","","4WD","",""`,
  ].join("\n");

  it("erkennt den deutschen Export, trennt Brutto und Gebühr, überspringt Fremdwährung und Ausstehendes", () => {
    expect(detectStatementFormat(bytes(german))).toBe("paypal-csv");
    const statement = parseStatement(bytes(german), "paypal.csv");
    expect(brief(statement)).toEqual([
      ["2026-10-01", 11_900, "Nordwerk Software GmbH", "Website-Zahlung · RE-2026-041 · 1AB23456CD789012E"],
      ["2026-10-01", -261, "PayPal", "Gebühr · 1AB23456CD789012E"],
      ["2026-10-05", -100_000, "DKB", "Allgemeine Abbuchung · 4WD"],
    ]);
    expect(statement.accountIban).toBeUndefined();
    expect(statement.warnings).toEqual([
      "1 Zeile übersprungen: nicht abgeschlossen (ausstehend, abgelehnt, storniert).",
      "1 Zeile übersprungen: nicht in Euro.",
    ]);
  });

  it("englische Spalten mit Dezimalpunkt und Datum Tag/Monat", () => {
    const english = [
      `"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","Transaction ID"`,
      `"30/09/2026","10:15:00","CEST","Nordwerk","Express Checkout Payment","Completed","EUR","1,190.00","-24.08","1,165.92","9AB"`,
    ].join("\n");
    expect(brief(parseStatement(bytes(english)))).toEqual([
      ["2026-09-30", 119_000, "Nordwerk", "Express Checkout Payment · 9AB"],
      ["2026-09-30", -2_408, "PayPal", "Gebühr · 9AB"],
    ]);
  });

  // #2025: Zahlung per Lastschrift vom Bankkonto wie im Issue, Namen und Codes erfunden. Die Autorisierungen sind nur
  // Vormerkungen („Auswirkung auf Guthaben“ = Memo), die Spalte „Guthaben“ bleibt bei ihnen gleich.
  const lastschrift = [
    `"Datum","Uhrzeit","Zeitzone","Name","Typ","Status","Währung","Brutto","Gebühr","Netto","Transaktionscode","Zugehöriger Transaktionscode","Guthaben","Auswirkung auf Guthaben"`,
    `"12.02.2026","09:14:02","MEZ","Beispiel Versand GmbH","Allgemeine Autorisierung","Ausstehend","EUR","-6,99","0,00","-6,99","1AA00000AA0000001","","0,00","Memo"`,
    `"12.02.2026","09:14:02","MEZ","Beispiel Versand GmbH","PayPal Express-Zahlung","Abgeschlossen","EUR","-6,99","0,00","-6,99","2BB00000BB0000002","1AA00000AA0000001","-6,99","Soll"`,
    `"12.02.2026","09:14:02","MEZ","","Bankgutschrift auf PayPal-Konto","Ausstehend","EUR","6,99","0,00","6,99","3CC00000CC0000003","2BB00000BB0000002","0,00","Haben"`,
    `"12.02.2026","09:14:03","MEZ","Beispiel Versand GmbH","Allgemeine Autorisierung","Abgeschlossen","EUR","-6,99","0,00","-6,99","1AA00000AA0000001","","0,00","Memo"`,
  ].join("\n");

  it("übernimmt Vormerkungen (Memo) nicht, die ausstehende Bankgutschrift zur Lastschrift aber schon (#2025)", () => {
    const statement = parseStatement(bytes(lastschrift), "paypal.csv");
    expect(brief(statement)).toEqual([
      ["2026-02-12", -699, "Beispiel Versand GmbH", "PayPal Express-Zahlung · 2BB00000BB0000002"],
      ["2026-02-12", 699, "", "Bankgutschrift auf PayPal-Konto · 3CC00000CC0000003"],
    ]);
    expect(statement.warnings).toEqual(["2 Zeilen übersprungen: Vormerkung ohne Wirkung auf das Guthaben (Memo)."]);
  });

  it("andere ausstehende Zeilen bleiben übersprungen, auch mit Wirkung „Haben“ (#2025)", () => {
    const pending = [
      `"Datum","Uhrzeit","Zeitzone","Name","Typ","Status","Währung","Brutto","Gebühr","Netto","Transaktionscode","Auswirkung auf Guthaben"`,
      `"13.02.2026","10:00:00","MEZ","Musterkunde","Website-Zahlung","Ausstehend","EUR","20,00","0,00","20,00","4DD00000DD0000004","Haben"`,
      `"13.02.2026","10:05:00","MEZ","","Bankgutschrift auf PayPal-Konto","Ausstehend","EUR","5,00","0,00","5,00","5EE00000EE0000005","Memo"`,
    ].join("\n");
    const statement = parseStatement(bytes(pending));
    expect(brief(statement)).toEqual([]);
    expect(statement.warnings).toEqual([
      "1 Zeile übersprungen: Vormerkung ohne Wirkung auf das Guthaben (Memo).",
      "1 Zeile übersprungen: nicht abgeschlossen (ausstehend, abgelehnt, storniert).",
    ]);
  });

  it("stornierte oder abgelehnte Bankgutschrift bleibt übersprungen, auch mit Wirkung „Haben“ (#2025)", () => {
    const declined = [
      `"Datum","Uhrzeit","Zeitzone","Name","Typ","Status","Währung","Brutto","Gebühr","Netto","Transaktionscode","Auswirkung auf Guthaben"`,
      `"14.02.2026","10:00:00","MEZ","","Bankgutschrift auf PayPal-Konto","Storniert","EUR","6,99","0,00","6,99","6FF00000FF0000006","Haben"`,
      `"14.02.2026","10:05:00","MEZ","","Bankgutschrift auf PayPal-Konto","Abgelehnt","EUR","7,00","0,00","7,00","7GG00000GG0000007","Haben"`,
    ].join("\n");
    const statement = parseStatement(bytes(declined));
    expect(brief(statement)).toEqual([]);
    expect(statement.warnings).toEqual(["2 Zeilen übersprungen: nicht abgeschlossen (ausstehend, abgelehnt, storniert)."]);
  });

  it("Zahlung aus dem Guthaben: Einbehaltung und Rückbuchung sind nur eine Reservierung und fallen als Paar weg (#2025)", () => {
    // Juli-Fall aus dem Issue (Zahlen von dort, Namen und Codes erfunden): Die ausstehende Einbehaltung senkt das Guthaben
    // (116,00 → 110,81), die Rückbuchung hebt sie wieder auf; echt ist nur die Zahlung über 5,19 €.
    const ausGuthaben = [
      `"Datum","Uhrzeit","Zeitzone","Name","Typ","Status","Währung","Brutto","Gebühr","Netto","Transaktionscode","Zugehöriger Transaktionscode","Guthaben","Auswirkung auf Guthaben"`,
      `"15.07.2026","10:41:18","MESZ","Beispiel Versand GmbH","Allgemeine Autorisierung","Ausstehend","EUR","-5,19","0,00","-5,19","8HH00000HH0000008","","116,00","Memo"`,
      `"15.07.2026","10:41:18","MESZ","","Einbehaltung für offene Autorisierung","Ausstehend","EUR","-5,19","0,00","-5,19","9JJ00000JJ0000009","8HH00000HH0000008","110,81","Soll"`,
      `"15.07.2026","10:41:21","MESZ","Beispiel Versand GmbH","PayPal Express-Zahlung","Abgeschlossen","EUR","-5,19","0,00","-5,19","0KK00000KK0000010","8HH00000HH0000008","105,62","Soll"`,
      `"15.07.2026","10:41:21","MESZ","","Rückbuchung allgemeiner Einbehaltung","Abgeschlossen","EUR","5,19","0,00","5,19","1LL00000LL0000011","9JJ00000JJ0000009","110,81","Haben"`,
      `"15.07.2026","10:41:21","MESZ","Beispiel Versand GmbH","Allgemeine Autorisierung","Abgeschlossen","EUR","-5,19","0,00","-5,19","8HH00000HH0000008","","110,81","Memo"`,
    ].join("\n");
    const statement = parseStatement(bytes(ausGuthaben));
    expect(brief(statement)).toEqual([["2026-07-15", -519, "Beispiel Versand GmbH", "PayPal Express-Zahlung · 0KK00000KK0000010"]]);
    expect(statement.warnings).toEqual([
      "2 Zeilen übersprungen: Vormerkung ohne Wirkung auf das Guthaben (Memo).",
      "2 Zeilen übersprungen: Einbehaltung und ihre Rückbuchung (nur eine Reservierung im Guthaben).",
    ]);
  });

  it("eine abgeschlossene Einbehaltung fällt mit ihrer Rückbuchung weg, auch englisch (#2025)", () => {
    const english = [
      `"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","Transaction ID","Balance Impact"`,
      `"20/07/2026","09:00:00","CEST","","General Account Hold","Completed","EUR","-50.00","0.00","-50.00","2MM00000MM0000012","Debit"`,
      `"21/07/2026","09:00:00","CEST","","Account Hold for Open Authorization","Pending","EUR","-6.39","0.00","-6.39","3NN00000NN0000013","Debit"`,
      `"22/07/2026","09:00:00","CEST","","Reversal of General Account Hold","Completed","EUR","50.00","0.00","50.00","4PP00000PP0000014","Credit"`,
    ].join("\n");
    const statement = parseStatement(bytes(english));
    expect(brief(statement)).toEqual([]);
    expect(statement.warnings).toEqual(["3 Zeilen übersprungen: Einbehaltung und ihre Rückbuchung (nur eine Reservierung im Guthaben)."]);
  });

  it("exportiert PayPal die Bankgutschrift später als abgeschlossen, legt ein erneuter Import sie nicht doppelt an (#2025)", () => {
    const later = lastschrift.replace(`"Bankgutschrift auf PayPal-Konto","Ausstehend"`, `"Bankgutschrift auf PayPal-Konto","Abgeschlossen"`);
    expect(later).not.toBe(lastschrift);
    const hashes = (text: string) => withDedupHashes(parseStatement(bytes(text)).transactions).map((t) => t.dedupHash);
    expect(hashes(later)).toEqual(hashes(lastschrift));
  });

  it("englische Spalten: „Balance Impact“ = Memo wird übersprungen, „Bank Deposit to PP Account“ übernommen (#2025)", () => {
    const english = [
      `"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","Transaction ID","Balance","Balance Impact"`,
      `"12/02/2026","09:14:02","CET","Example Shipping Ltd","General Authorization","Completed","EUR","-6.99","0.00","-6.99","1AA00000AA0000001","0.00","Memo"`,
      `"12/02/2026","09:14:02","CET","Example Shipping Ltd","Express Checkout Payment","Completed","EUR","-6.99","0.00","-6.99","2BB00000BB0000002","-6.99","Debit"`,
      `"12/02/2026","09:14:02","CET","","Bank Deposit to PP Account ","Pending","EUR","6.99","0.00","6.99","3CC00000CC0000003","0.00","Credit"`,
    ].join("\n");
    const statement = parseStatement(bytes(english));
    expect(brief(statement)).toEqual([
      ["2026-02-12", -699, "Example Shipping Ltd", "Express Checkout Payment · 2BB00000BB0000002"],
      ["2026-02-12", 699, "", "Bank Deposit to PP Account · 3CC00000CC0000003"],
    ]);
    expect(statement.warnings).toEqual(["1 Zeile übersprungen: Vormerkung ohne Wirkung auf das Guthaben (Memo)."]);
  });
});

describe("Stripe", () => {
  it("Saldenverlauf (alter Export): Zahlung, Gebühr negativ, Auszahlung", () => {
    const csv = [
      `id,Type,Source,Amount,Fee,Net,Currency,Created (UTC),Available On (UTC),Description`,
      `txn_1,charge,ch_1,119.00,1.92,117.08,eur,2026-10-01 10:00:00,2026-10-08 00:00:00,Rechnung RE-2026-042`,
      `txn_2,payout,po_1,-117.08,0.00,-117.08,eur,2026-10-08 06:00:00,2026-10-08 00:00:00,STRIPE PAYOUT`,
      `txn_3,charge,ch_2,10.00,0.50,9.50,usd,2026-10-02 10:00:00,2026-10-09 00:00:00,US`,
    ].join("\n");
    expect(detectStatementFormat(bytes(csv))).toBe("stripe-csv");
    const statement = parseStatement(bytes(csv));
    expect(brief(statement)).toEqual([
      ["2026-10-01", 11_900, "Rechnung RE-2026-042", "charge · Rechnung RE-2026-042 · txn_1"],
      ["2026-10-01", -192, "Stripe", "Gebühr · txn_1"],
      ["2026-10-08", -11_708, "Stripe", "payout · STRIPE PAYOUT · txn_2"],
    ]);
    // Mit „Customer Facing Amount“ (ab 2019 im alten Export): der Betrag ist keine Gegenpartei
    const withAmount = [
      `id,Type,Source,Amount,Fee,Net,Currency,Created (UTC),Available On (UTC),Description,Customer Facing Amount,Customer Facing Currency`,
      `txn_1,charge,ch_1,119.00,1.92,117.08,eur,2026-10-01 10:00:00,2026-10-08 00:00:00,Rechnung RE-2026-042,119.00,eur`,
    ].join("\n");
    expect(parseStatement(bytes(withAmount)).transactions[0]?.counterpartyName).toBe("Rechnung RE-2026-042");
    expect(statement.warnings).toEqual(["1 Zeile übersprungen: nicht in Euro."]);
  });

  it("Zahlung ohne Kunde und Beschreibung bekommt einen Hinweis, mit Kunde füllt sich der Name, der Zweck und damit der Dedup-Hash bleiben", () => {
    const bare = [
      `balance_transaction_id,created_utc,available_on_utc,currency,gross,fee,net,reporting_category`,
      `txn_1,2026-11-15 08:00:00,2026-11-22 00:00:00,eur,56.00,1.09,54.91,charge`,
      `txn_2,2026-11-16 06:00:00,2026-11-16 00:00:00,eur,-54.91,0.00,-54.91,payout`,
    ].join("\n");
    const statement = parseStatement(bytes(bare));
    expect(brief(statement)[0]).toEqual(["2026-11-15", 5_600, "", "charge · txn_1"]);
    expect(statement.warnings).toEqual([expect.stringContaining("1 Zahlung hat weder Kunde noch Beschreibung")]);
    const full = [
      `balance_transaction_id,created_utc,available_on_utc,currency,gross,fee,net,reporting_category,description,customer_name,customer_email`,
      `txn_1,2026-11-15 08:00:00,2026-11-22 00:00:00,eur,56.00,1.09,54.91,charge,,Beispiel GmbH,a@beispiel.test`,
    ].join("\n");
    const named = parseStatement(bytes(full));
    expect(brief(named)[0]).toEqual(["2026-11-15", 5_600, "Beispiel GmbH", "charge · txn_1"]);
    expect(named.warnings).toEqual([]);
    // Derselbe Export mit und ohne Kundenspalten ergibt dieselben Hashes: ein erneuter Import legt nichts doppelt an
    expect(withDedupHashes(named.transactions).map((t) => t.dedupHash)).toEqual(
      withDedupHashes(statement.transactions)
        .slice(0, 2)
        .map((t) => t.dedupHash),
    );
  });

  it("ohne Kundenname gilt die E-Mail-Adresse, mehrere Zahlungen ohne Kunde ergeben einen Hinweis im Plural", () => {
    const email = [
      `balance_transaction_id,created_utc,available_on_utc,currency,gross,fee,net,reporting_category,description,customer_name,customer_email`,
      `txn_1,2026-11-15 08:00:00,2026-11-22 00:00:00,eur,56.00,1.09,54.91,charge,,,kunde@beispiel.test`,
    ].join("\n");
    expect(brief(parseStatement(bytes(email)))[0]).toEqual(["2026-11-15", 5_600, "kunde@beispiel.test", "charge · txn_1"]);
    const zwei = [
      `balance_transaction_id,created_utc,available_on_utc,currency,gross,fee,net,reporting_category`,
      `txn_1,2026-11-15 08:00:00,2026-11-22 00:00:00,eur,56.00,1.09,54.91,charge`,
      `txn_2,2026-11-16 08:00:00,2026-11-23 00:00:00,eur,10.00,0.50,9.50,payment`,
    ].join("\n");
    expect(parseStatement(bytes(zwei)).warnings).toEqual([expect.stringContaining("2 Zahlungen haben weder Kunde noch Beschreibung")]);
  });

  it("kein Hinweis, wenn der Bericht die Kundenspalten schon hat, auch wenn sie bei einer Gast-Zahlung leer sind", () => {
    const csv = [
      `balance_transaction_id,created_utc,available_on_utc,currency,gross,fee,net,reporting_category,description,customer_name,customer_email`,
      `txn_1,2026-11-15 08:00:00,2026-11-22 00:00:00,eur,56.00,1.09,54.91,charge,,,`,
    ].join("\n");
    expect(parseStatement(bytes(csv)).warnings).toEqual([]);
  });

  it("neuer Export mit reporting_category", () => {
    const csv = [
      `balance_transaction_id,created_utc,available_on_utc,currency,gross,fee,net,reporting_category,description`,
      `txn_9,2026-10-03 08:00:00,2026-10-10 00:00:00,eur,59.50,1.08,58.42,charge,Abo`,
    ].join("\n");
    expect(brief(parseStatement(bytes(csv)))).toEqual([
      ["2026-10-03", 5_950, "Abo", "charge · Abo · txn_9"],
      ["2026-10-03", -108, "Stripe", "Gebühr · txn_9"],
    ]);
  });
});

describe("Shopify Payments", () => {
  const header = `Transaction Date,Type,Order,Card Brand,Card Source,Payout Status,Payout Date,Payout ID,Available On,Amount,Fee,Net,Checkout,Payment Method Name,Presentment Amount,Presentment Currency,Currency`;

  it("Transaktionen mit Gebühr, Auszahlung als ein Teil je ausgezahlter Transaktion", () => {
    const csv = [
      `Transaction Date,Type,Order,Card Brand,Card Source,Payout Status,Payout Date,Payout ID,Available On,Amount,Fee,Net,Checkout,Payment Method Name,Presentment Amount,Presentment Currency,Currency`,
      `2026-10-01 12:00:00 +0200,charge,#1001,visa,online,paid,2026-10-04,98765,2026-10-04,49.90,1.27,48.63,c1,card,49.90,EUR,EUR`,
      `2026-10-02 09:00:00 +0200,charge,#1002,mastercard,online,paid,2026-10-04,98765,2026-10-04,29.90,0.82,29.08,c2,card,29.90,EUR,EUR`,
      `2026-10-03 09:00:00 +0200,refund,#1001,visa,online,pending,,,,-49.90,0.00,-49.90,c1,card,-49.90,EUR,EUR`,
    ].join("\n");
    expect(detectStatementFormat(bytes(csv))).toBe("shopify-payments-csv");
    expect(brief(parseStatement(bytes(csv)))).toEqual([
      ["2026-10-01", 4_990, "Bestellung #1001", "charge · Bestellung #1001"],
      ["2026-10-01", -127, "Shopify Payments", "Gebühr · charge · Bestellung #1001"],
      ["2026-10-02", 2_990, "Bestellung #1002", "charge · Bestellung #1002"],
      ["2026-10-02", -82, "Shopify Payments", "Gebühr · charge · Bestellung #1002"],
      ["2026-10-03", -4_990, "Bestellung #1001", "refund · Bestellung #1001"],
      ["2026-10-04", -4_863, "Shopify Payments", "Auszahlung 98765 · charge · Bestellung #1001 · 2026-10-01"],
      ["2026-10-04", -2_908, "Shopify Payments", "Auszahlung 98765 · charge · Bestellung #1002 · 2026-10-02"],
    ]);
  });

  const hashes = (text: string) => new Map(withDedupHashes(parseStatement(bytes(text)).transactions).map((t) => [t.purpose, t.dedupHash]));

  it("dieselbe Zahlung vor und nach der Auszahlung exportiert: gleicher Hash, der Auszahlungsteil kommt dazu", () => {
    const early = hashes([header, `2026-10-01 12:00:00 +0200,charge,#1001,visa,online,pending,,,2026-10-04,49.90,1.27,48.63,c1,card,49.90,EUR,EUR`].join("\n"));
    const late = hashes(
      [header, `2026-10-01 12:00:00 +0200,charge,#1001,visa,online,paid,2026-10-04,98765,2026-10-04,49.90,1.27,48.63,c1,card,49.90,EUR,EUR`].join("\n"),
    );
    expect(late.get("charge · Bestellung #1001")).toBe(early.get("charge · Bestellung #1001"));
    expect([...late.keys()].filter((p) => !early.has(p))).toEqual(["Auszahlung 98765 · charge · Bestellung #1001 · 2026-10-01"]);
  });

  it("Auszahlung über die Monatsgrenze: die Teile aus beiden Exporten ergeben zusammen den Eingang auf der Bank", () => {
    const september = [
      header,
      `2026-09-30 12:00:00 +0200,charge,#1001,visa,online,paid,2026-10-02,98765,2026-10-02,49.90,1.27,48.63,c1,card,49.90,EUR,EUR`,
    ].join("\n");
    const october = [header, `2026-10-01 09:00:00 +0200,charge,#1002,visa,online,paid,2026-10-02,98765,2026-10-02,29.90,0.82,29.08,c2,card,29.90,EUR,EUR`].join(
      "\n",
    );
    const both = [header, september.split("\n")[1], october.split("\n")[1]].join("\n");
    const parts = (text: string) => parseStatement(bytes(text)).transactions.filter((t) => t.type === "Auszahlung");
    expect([...parts(september), ...parts(october)].reduce((s, t) => s + t.amount, 0)).toBe(-7_771);
    // Ein überlappender Export bringt keine neuen Teile: dieselben Hashes
    const separate = new Set([...hashes(september).values(), ...hashes(october).values()]);
    expect([...hashes(both).values()].every((h) => separate.has(h))).toBe(true);
  });
});
