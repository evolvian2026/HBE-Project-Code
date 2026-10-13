import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

// Every page is rendered per request, with that response's CSP nonce on its scripts.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "HBE Projects", template: "%s · HBE Projects" },
  description: "Full-stack project evaluation and management for students and educators.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
