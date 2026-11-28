import { beitrag } from "./rechnen.ts";
import { KEINE, type Minijob, mitSummen, type SvBeitraege } from "./typen.ts";
import type { SvJahreswerte } from "./werte.ts";
import type { Cents } from "../money.ts";

/**
 * Rentenversicherung im Minijob. Der Arbeitgeber trägt 15 % des tatsächlichen Entgelts, ohne Befreiung der
 * Beschäftigte den Rest (§ 168 Abs. 1 Nr. 1b SGB VI); beitragspflichtig ist mindestens 175 € (§ 163 Abs. 8 SGB VI).
 * Über 175 € rundet Haben den vollen Beitrag (18,6 %) und den Anteil des Beschäftigten (3,6 %); der Arbeitgeber
 * trägt die Differenz. So rechnen der Minijob-Rechner der Minijob-Zentrale und DATEV Lohn in der Beitragsgruppe 0100
 * (#1619): 542,10 € → 100,83 € − 19,52 € = 81,31 €. Nach dem Wortlaut von § 2 Abs. 1 Satz 3 BVV wäre der Beitrag
 * die Summe der getrennt gerundeten Anteile (81,32 € + 19,52 € = 100,84 €); Haben folgt bewusst der Praxis der
 * Einzugsstelle. Bis 175 € ist der Beitrag der volle Satz auf 175 €, gerundet, und der Beschäftigte trägt ihn
 * abzüglich des gerundeten Arbeitgeberanteils (§ 2 Abs. 1 Satz 5 BVV); Beispiel der Minijob-Zentrale: 100 € →
 * 32,55 € − 15,00 € = 17,55 €. Mit Befreiung zahlt nur der Arbeitgeber seine 15 %.
 */
function rente(e: Minijob, w: SvJahreswerte): { bemessung: Cents; an: Cents; ag: Cents } {
  const ag = beitrag(e.entgelt, w.minijobRvAg);
  if (e.rvBefreit) return { bemessung: e.entgelt, an: 0, ag };
  if (e.entgelt > w.minijobRvMindestbemessung) {
    const an = beitrag(e.entgelt, w.rv - w.minijobRvAg);
    return { bemessung: e.entgelt, an, ag: beitrag(e.entgelt, w.rv) - an };
  }
  return { bemessung: w.minijobRvMindestbemessung, an: beitrag(w.minijobRvMindestbemessung, w.rv) - ag, ag };
}

/**
 * Gewerblicher Minijob: Pauschalen an die Minijob-Zentrale, Umlagen U1/U2 zu deren Sätzen, Insolvenzgeldumlage,
 * keine Beiträge zur Pflege- und Arbeitslosenversicherung. Bemessung ist das tatsächliche Entgelt; die
 * Mindestbemessung von 175 € gilt nur für den Rentenbeitrag.
 */
export function minijob(e: Minijob, w: SvJahreswerte): SvBeitraege {
  const rv = rente(e, w);
  return mitSummen({
    personengruppe: "minijob",
    bemessung: { kvPv: e.entgelt, rvAv: rv.bemessung, arbeitnehmer: null },
    kv: { an: 0, ag: e.gesetzlichKrankenversichert ? beitrag(e.entgelt, w.minijobKv) : 0 },
    kvZusatz: KEINE,
    pv: KEINE,
    rv: { an: rv.an, ag: rv.ag },
    av: KEINE,
    umlagen: {
      u1: e.u1 ? beitrag(e.entgelt, w.minijobU1) : 0,
      u2: beitrag(e.entgelt, w.minijobU2),
      insolvenzgeld: beitrag(e.entgelt, w.insolvenzgeld),
    },
    pauschsteuer: e.pauschsteuer ? beitrag(e.entgelt, w.minijobPauschsteuer) : 0,
  });
}
