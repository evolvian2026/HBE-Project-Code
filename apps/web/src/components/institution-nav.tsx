"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function InstitutionNav({ slug, tabs }: { slug: string; tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Institution" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((tab) => {
        const href = `/i/${slug}${tab.href}`;
        const active = tab.href === "" ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={tab.href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
              active ? "border-accent font-medium text-text" : "border-transparent text-muted hover:text-text"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
