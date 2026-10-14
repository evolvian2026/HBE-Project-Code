import type { ReactNode } from "react";
import { ChartTips } from "./chart-tips";

/**
 * Charts for the analytics pages, drawn as plain HTML from server components. They follow the
 * dataviz method: one series hue (--viz-1) or a validated one-hue ramp (--viz-seq-*), thin
 * marks with 4px rounded ends and 2px gaps, text in text colours (never the data colour), a
 * tooltip on every mark and a table view with every value.
 */

export function StatTiles({ items }: { items: { label: string; value: string; note?: string }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((t) => (
        <div key={t.label} className="rounded-md border border-border p-3">
          <dt className="text-xs text-muted">{t.label}</dt>
          <dd className="mt-1 text-2xl font-semibold">{t.value}</dd>
          {t.note && <dd className="mt-0.5 text-xs text-muted">{t.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** A table with the chart's values, behind a disclosure. */
export function TableView({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-muted hover:text-text">Show as a table</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead className="text-xs text-muted">
            <tr>
              {head.map((h) => (
                <th key={h} scope="col" className="py-1 pr-4 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className="py-1 pr-4">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Horizontal bars, one series, each labelled at its tip. `value` is 0–1 of the full width. */
export function BarList({
  label,
  rows,
}: {
  label: string;
  rows: { key: string; name: string; value: number; display: string; tip: string }[];
}) {
  return (
    <ChartTips>
      <ul aria-label={label} className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.key}
            className="grid grid-cols-1 items-center gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(0,14rem)_1fr]"
          >
            <span className="truncate" title={r.name}>
              {r.name}
            </span>
            <span className="flex items-center gap-2" data-tip={r.tip}>
              <span className="h-3 flex-1">
                <span
                  className="block h-3 rounded-r-[4px]"
                  style={{ width: `${Math.max(r.value > 0 ? 1 : 0, r.value * 100)}%`, background: "var(--viz-1)" }}
                />
              </span>
              <span className="shrink-0 text-right tabular-nums text-muted sm:w-24">{r.display}</span>
            </span>
          </li>
        ))}
      </ul>
    </ChartTips>
  );
}

/** Columns for a 0–100 score distribution, one series. */
export function ScoreColumns({
  label,
  bins,
  unit,
}: {
  label: string;
  bins: { from: number; to: number; count: number }[];
  unit: string;
}) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  return (
    <ChartTips>
      <figure aria-label={label}>
        <div className="flex items-end gap-0.5 border-b" style={{ height: "8rem", borderColor: "var(--viz-grid)" }}>
          {bins.map((b) => (
            <div
              key={b.from}
              className="flex h-full flex-1 items-end justify-center"
              data-tip={`${b.from}–${b.to === 100 ? 100 : b.to - 1}: ${b.count} ${b.count === 1 ? unit.replace(/s$/, "") : unit}`}
            >
              <div
                className="w-full max-w-6 rounded-t-[4px]"
                style={{ height: `${(b.count / max) * 100}%`, background: "var(--viz-1)" }}
              />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-xs tabular-nums text-muted">
          <span>0</span>
          <span>50</span>
          <span>100</span>
        </div>
        <figcaption className="mt-1 text-xs text-muted">
          Tallest column: {max} {max === 1 ? unit.replace(/s$/, "") : unit}
        </figcaption>
      </figure>
    </ChartTips>
  );
}

const STEP = (share: number) => (share === 0 ? 0 : Math.min(5, Math.ceil(share * 5)));
const BANDS = ["none", "1–20%", "21–40%", "41–60%", "61–80%", "81–100%"];

/** Tests by days: how many of each day's runs failed each test (none, then five bands). */
export function FailureHeatMap({
  days,
  rows,
  dayLabel,
}: {
  days: string[];
  rows: { key: string; title: string; cells: { runs: number; failed: number }[] }[];
  dayLabel: (day: string) => string;
}) {
  const cols = `minmax(0,12rem) repeat(${days.length}, minmax(0.875rem, 1.25rem))`;
  const tick = (i: number) => i === 0 || i === days.length - 1 || i === Math.floor((days.length - 1) / 2);
  return (
    <ChartTips>
      <div className="overflow-x-auto">
        <div role="img" aria-label="Failures of each test by day (the table below has every value)">
          <div className="grid gap-0.5 text-sm" style={{ gridTemplateColumns: cols }}>
            {rows.map((r) => (
              <Row key={r.key}>
                <span className="truncate pr-2" title={r.title}>
                  {r.title}
                </span>
                {r.cells.map((c, i) => (
                  <span
                    key={days[i]}
                    data-tip={`${dayLabel(days[i]!)} · ${r.title}: ${
                      c.runs ? `${c.failed} of ${c.runs} runs failed` : "no runs"
                    }`}
                    className={`aspect-square rounded-[3px] ${c.runs ? "" : "border border-border"}`}
                    style={c.runs ? { background: `var(--viz-seq-${STEP(c.failed / c.runs)})` } : undefined}
                  />
                ))}
              </Row>
            ))}
            <span />
            {days.map((d, i) => (
              <span key={d} className="relative h-5 text-xs text-muted">
                {tick(i) && <span className="absolute left-0 top-1 whitespace-nowrap">{dayLabel(d)}</span>}
              </span>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>Runs failing the test:</span>
        {BANDS.map((b, i) => (
          <span key={b} className="flex items-center gap-1">
            <span className="inline-block size-3 rounded-[3px]" style={{ background: `var(--viz-seq-${i})` }} />
            {b}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="inline-block size-3 rounded-[3px] border border-border" />
          no runs
        </span>
      </p>
    </ChartTips>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export const percent = (share: number) => `${Math.round(share * 100)}%`;
