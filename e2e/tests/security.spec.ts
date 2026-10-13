import { expect, test } from "@playwright/test";
import { createInstitutionWithAdmin, setUpMfa, signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `sec-${suffix}`;

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
});

test("pages are sent with a per-response Content-Security-Policy that their own scripts satisfy", async ({
  page,
  request,
}) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });

  const first = await request.get("/login");
  const second = await request.get("/login");
  const csp = first.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(second.headers()["content-security-policy"]).not.toBe(csp); // a new nonce each time
  expect(first.headers()["x-frame-options"]).toBe("DENY");
  expect(first.headers()["x-content-type-options"]).toBe("nosniff");
  expect(first.headers()["strict-transport-security"]).toContain("max-age=");

  // Signed in, the app works (client components hydrate) and nothing is blocked.
  await createInstitutionWithAdmin(slug, `Secure U ${suffix}`, email("admin"));
  await signIn(page, email("admin"));
  await setUpMfa(page); // a client-side form, and a QR code image (data: URL)
  await page.goto(`/i/${slug}/members`);
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  // Every script on the page carries the response's nonce.
  const unsigned = await page.evaluate(() => Array.from(document.scripts).filter((s) => !s.nonce).length);
  expect(unsigned).toBe(0);
  expect(violations).toEqual([]);
});
