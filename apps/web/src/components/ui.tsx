import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";
const buttonVariants = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "border border-border bg-surface text-text hover:bg-surface-2",
  danger: "bg-danger text-white hover:opacity-90",
} as const;

type Variant = keyof typeof buttonVariants;

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ComponentProps<"button"> & { variant?: Variant }) {
  return <button className={`${buttonBase} ${buttonVariants[variant]} ${className}`} {...props} />;
}

export function ButtonLink({
  variant = "primary",
  className = "",
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={`${buttonBase} ${buttonVariants[variant]} ${className}`} {...props} />;
}

export function Card({
  title,
  description,
  actions,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface">
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

const badgeTones = {
  neutral: "bg-surface-2 text-muted",
  accent: "bg-accent/10 text-accent",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
} as const;

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badgeTones[tone]}`}>
      {children}
    </span>
  );
}

const alertTones = {
  info: "border-accent/30 bg-accent/5 text-text",
  success: "border-success/30 bg-success-bg text-success",
  error: "border-danger/30 bg-danger-bg text-danger",
} as const;

export function Alert({ tone = "info", children }: { tone?: keyof typeof alertTones; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-md border px-4 py-3 text-sm ${alertTones[tone]}`}
    >
      {children}
    </div>
  );
}

export function Field({ label, hint, id, ...input }: ComponentProps<"input"> & { label: string; hint?: string }) {
  const inputId = id ?? `field-${input.name}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <div className="text-sm">
      <label htmlFor={inputId} className="font-medium">
        {label}
      </label>
      <input
        id={inputId}
        aria-describedby={hintId}
        className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
        {...input}
      />
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function roleTone(role: string): keyof typeof badgeTones {
  return role === "admin" ? "accent" : role === "teacher" ? "success" : "neutral";
}
