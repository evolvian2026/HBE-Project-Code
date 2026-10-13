import Link from "next/link";

const PAGES = [
  { href: "/account/security", label: "Security" },
  { href: "/account/notifications", label: "Email notifications" },
  { href: "/account/data", label: "Your data" },
] as const;

/** Moves between the account pages. */
export function AccountNav({ current }: { current: (typeof PAGES)[number]["href"] }) {
  return (
    <nav aria-label="Account" className="mb-6 flex flex-wrap gap-4 border-b border-border text-sm">
      {PAGES.map((p) => (
        <Link
          key={p.href}
          href={p.href}
          aria-current={p.href === current ? "page" : undefined}
          className={`-mb-px border-b-2 pb-2 ${p.href === current ? "border-accent font-medium" : "border-transparent text-muted hover:text-text"}`}
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}
