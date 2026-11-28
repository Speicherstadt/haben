import { MONTHS, formatEuro } from "@haben/core";
import { useState, type PointerEvent } from "react";
import { euroAxis, niceTicks, useChartWidth } from "../lib/chart.ts";
import { formatDate } from "../lib/format.ts";

const H = 200;
const M = { top: 12, right: 12, bottom: 24, left: 72 };
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

export interface BalancePoint {
  date: string;
  /** Saldo nach der Buchung, aus Sicht des Kontos (Erlöse positiv) */
  value: number;
  label: string;
}

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/** Beschriftung der Grenze in .tick (12 px): grob 7 px je Zeichen, 4 px Abstand zur Linie, das Band ist so hoch wie der Text samt Abstand */
const LABEL_ZEICHEN = 7;
const LABEL_ABSTAND = 4;
const LABEL_BAND = 14;

/**
 * Wohin die Beschriftung der Grenze kommt (#1381): über die Linie, außer die Kurve verläuft im x-Bereich der Beschriftung
 * (von bis bis) im Band direkt darüber und lässt das Band darunter frei; belegt sie beide, bleibt sie oben. stufen sind die
 * Ecken der Kurve (nur waagrechte und senkrechte Strecken), linie die y-Koordinate der Grenze; y wächst nach unten. Es zählen
 * die waagrechten Strecken: Eine senkrechte Stufe kreuzt den Text nur auf zwei Pixeln und bleibt neben ihm sichtbar.
 */
export function grenzeLabelSeite(stufen: readonly { x: number; y: number }[], von: number, bis: number, linie: number): "oben" | "unten" {
  const stand = stufen
    .slice(1)
    .filter((p, i) => p.y === stufen[i]!.y && Math.max(p.x, stufen[i]!.x) >= von && Math.min(p.x, stufen[i]!.x) <= bis)
    .map((p) => p.y);
  const oben = stand.some((y) => y < linie && y >= linie - LABEL_BAND);
  const unten = stand.some((y) => y > linie && y <= linie + LABEL_BAND);
  return oben && !unten ? "unten" : "oben";
}

/**
 * Saldoverlauf eines Kontos als Stufenlinie: zwischen zwei Buchungen bleibt der Saldo gleich.
 * Eine Reihe, daher keine Legende; Titel und Tabelle darunter benennen sie. `grenze` zeichnet einen Wert als gestrichelte
 * Linie mit Beschriftung, etwa den Mindestbestand der Liquiditätsvorschau (#1381).
 */
export function BalanceChart({
  from,
  to,
  start,
  points,
  title,
  grenze,
}: {
  from: string;
  to: string;
  start: number;
  points: BalancePoint[];
  title: string;
  grenze?: { value: number; label: string };
}) {
  const [active, setActive] = useState<number | null>(null);
  const [chartRef, W] = useChartWidth();
  const first = day(from);
  const last = Math.max(day(to) - 1, first + 1);
  const values = [start, ...points.map((p) => p.value), ...(grenze ? [grenze.value] : [])];
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const x = (iso: string) => M.left + ((day(iso) - first) / (last - first)) * plotW;
  const y = (v: number) => M.top + plotH - ((v - lo) / (hi - lo)) * plotH;

  let d = `M${M.left},${y(start)}`;
  let current = start;
  const stufen = [{ x: M.left, y: y(start) }];
  for (const p of points) {
    d += `H${x(p.date)}V${y(p.value)}`;
    stufen.push({ x: x(p.date), y: y(current) }, { x: x(p.date), y: y(p.value) });
    current = p.value;
  }
  d += `H${W - M.right}`;
  stufen.push({ x: W - M.right, y: y(current) });
  const linie = grenze ? y(grenze.value) : 0;
  // Unter der Linie nur mit Platz im Diagramm: Ganz unten (0 € auf der Nulllinie) stünde sie auf der Achse der Monate
  const labelUnten =
    grenze !== undefined &&
    linie + LABEL_BAND <= M.top + plotH &&
    grenzeLabelSeite(stufen, W - M.right - grenze.label.length * LABEL_ZEICHEN, W - M.right, linie) === "unten";

  // Monatsanfänge im Zeitraum als Achsenbeschriftung
  const monthTicks: { iso: string; label: string }[] = [];
  for (let m = new Date(`${from}T00:00:00Z`); day(m.toISOString().slice(0, 10)) <= last; m.setUTCMonth(m.getUTCMonth() + 1)) {
    const iso = m.toISOString().slice(0, 10);
    monthTicks.push({ iso, label: MONTHS_SHORT[m.getUTCMonth()]! });
  }

  function onMove(event: PointerEvent<SVGSVGElement>) {
    if (points.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.date) - px) < Math.abs(x(points[best]!.date) - px)) best = i;
    });
    setActive(best);
  }

  const point = active !== null ? points[active] : null;
  return (
    <div className="chart" ref={chartRef} onPointerLeave={() => setActive(null)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title}: Saldo von ${formatEuro(start)} auf ${formatEuro(current)}${grenze ? `, ${grenze.label} ${formatEuro(grenze.value)}` : ""}`}
        onPointerMove={onMove}
      >
        <g aria-hidden="true">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} className={t === 0 ? "axis-base" : "grid"} />
              <text x={M.left - 8} y={y(t)} dy="0.32em" style={{ textAnchor: "end" }} className="tick">
                {euroAxis.format(t / 100)} €
              </text>
            </g>
          ))}
          {monthTicks.length <= 12 &&
            monthTicks.map((m, i) =>
              // Schmale Diagramme: nur jeden zweiten Monat beschriften
              i % (W < 520 ? 2 : 1) === 0 ? (
                <text key={m.iso} x={x(m.iso)} y={H - 6} style={{ textAnchor: "start" }} className="tick">
                  {m.label}
                </text>
              ) : null,
            )}
        </g>
        {/* Die Linie liegt unter der Kurve, die Beschriftung darüber ohne Rand: Überlappen sich Text und Kurve, bleiben beide sichtbar */}
        {grenze && <line x1={M.left} x2={W - M.right} y1={linie} y2={linie} className="grenze" aria-hidden="true" />}
        <path d={d} className="line-series" />
        {grenze && (
          <text
            x={W - M.right}
            y={labelUnten ? linie + LABEL_BAND - 1 : linie - LABEL_ABSTAND}
            style={{ textAnchor: "end" }}
            className="tick grenze-label"
            aria-hidden="true"
          >
            {grenze.label}
          </text>
        )}
        {point && (
          <g aria-hidden="true">
            <line x1={x(point.date)} x2={x(point.date)} y1={M.top} y2={M.top + plotH} className="crosshair" />
            <circle cx={x(point.date)} cy={y(point.value)} r={5} className="marker" />
          </g>
        )}
      </svg>
      {point && (
        <div
          className="chart-tooltip"
          role="presentation"
          style={{
            left: `${(x(point.date) / W) * 100}%`,
            transform: x(point.date) < W * 0.2 ? "translateX(-10%)" : x(point.date) > W * 0.8 ? "translateX(-90%)" : "translateX(-50%)",
          }}
        >
          <div className="tt-title">{formatDate(point.date)}</div>
          <div className="tt-row">
            <strong>{formatEuro(point.value)}</strong>
            <span className="muted">Saldo</span>
          </div>
          <div className="small muted" style={{ maxWidth: 260, whiteSpace: "normal" }}>
            {point.label}
          </div>
        </div>
      )}
    </div>
  );
}
