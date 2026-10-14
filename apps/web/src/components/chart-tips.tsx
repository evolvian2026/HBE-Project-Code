"use client";

import { useRef, useState, type ReactNode } from "react";

/**
 * One tooltip for every mark inside: any element with `data-tip` shows its text on hover or
 * keyboard focus. The text is set as text content (data from the database is never HTML).
 * Tooltips add convenience only; each chart has a table view with the same values.
 */
export function ChartTips({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  const show = (target: EventTarget | null, x?: number, y?: number) => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>("[data-tip]");
    const box = root.current?.getBoundingClientRect();
    if (!el || !box || !root.current?.contains(el)) return setTip(null);
    const mark = el.getBoundingClientRect();
    setTip({
      text: el.dataset.tip ?? "",
      x: (x ?? mark.left + mark.width / 2) - box.left,
      y: (y ?? mark.top) - box.top,
    });
  };

  return (
    <div
      ref={root}
      className="relative"
      onPointerMove={(e) => show(e.target, e.clientX, e.clientY)}
      onPointerLeave={() => setTip(null)}
      onFocus={(e) => show(e.target)}
      onBlur={() => setTip(null)}
    >
      {children}
      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 max-w-64 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text shadow-sm"
          style={{ left: tip.x, top: tip.y - 8 }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
}
