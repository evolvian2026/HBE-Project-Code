"use client";

import { useRouter } from "next/navigation";

export function InstitutionSwitcher({
  current,
  options,
}: {
  current: string | null;
  options: { slug: string; name: string }[];
}) {
  const router = useRouter();
  if (options.length === 0) return null;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Institution</span>
      <select
        className="max-w-56 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
        value={current ?? ""}
        onChange={(e) => router.push(e.target.value ? `/i/${e.target.value}` : "/")}
      >
        {!current && <option value="">Choose institution…</option>}
        {options.map((o) => (
          <option key={o.slug} value={o.slug}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
