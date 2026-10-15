import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "./lib/csp";
import { APP_ROUTES, lookupHost } from "./lib/hosts";
import { redirectAcross } from "./lib/redirect";

const PUBLIC_PATHS = ["/login", "/auth/", "/lti/pending"];
/** Pages that only exist on the platform's own address. */
const PLATFORM_ONLY = ["/platform", "/github/", "/lti/", "/auth/handoff/start", "/signed-out"];

/**
 * Refreshes the Supabase session cookie on every request, gates signed-in pages and sets the
 * Content-Security-Policy. On an institution's own address (its subdomain or vanity domain,
 * Phase 3E) it serves that institution's pages: `/` is its home and `/courses` its courses;
 * signing in happens on the platform's address, which hands the session back
 * (/auth/handoff/start there, /auth/handoff here).
 */
export async function middleware(request: NextRequest) {
  const appUrl = new URL(process.env.APP_URL!);
  const path = request.nextUrl.pathname;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const site = await lookupHost(host);
  let rewriteTo: URL | null = null;
  if (!site.platform) {
    if (!site.slug) return new NextResponse("No institution is served at this address.", { status: 404 });
    const here = `${appUrl.protocol}//${host}`;
    const onPlatform = (p: string) => redirectAcross(new URL(p, appUrl));
    if (PLATFORM_ONLY.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p))) {
      return onPlatform(`${path}${request.nextUrl.search}`);
    }
    if (path === "/login") {
      const next = request.nextUrl.searchParams.get("next");
      return onPlatform(`/auth/handoff/start?to=${encodeURIComponent(`${here}${next?.startsWith("/") ? next : "/"}`)}`);
    }
    const [, first = ""] = path.split("/");
    // Another institution's pages belong on its own address (or the platform's).
    if (first === "i" && path.split("/")[2] && path.split("/")[2] !== site.slug) return onPlatform(path);
    if (path === "/" || !APP_ROUTES.has(first)) {
      rewriteTo = request.nextUrl.clone();
      rewriteTo.pathname = `/i/${site.slug}${path === "/" ? "" : path}`;
    }
  }

  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce, process.env.SUPABASE_URL!, process.env.NODE_ENV === "development");
  // Next reads the nonce from the request's policy and puts it on the scripts it renders.
  request.headers.set("x-nonce", nonce);
  request.headers.set("content-security-policy", csp);
  // One id for the page and the API calls made for it (apiFetch passes it on).
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  request.headers.set("x-request-id", requestId);
  const pass = () => (rewriteTo ? NextResponse.rewrite(rewriteTo, { request }) : NextResponse.next({ request }));
  let response = pass();
  const supabase = createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    cookieOptions: { secure: appUrl.protocol === "https:" },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = pass();
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(p));
  if (!data?.claims?.sub && !isPublic) {
    if (!site.platform) {
      // Sign in on the platform's address, then come back here.
      const back = `${appUrl.protocol}//${host}${path}${request.nextUrl.search}`;
      return redirectAcross(new URL(`/auth/handoff/start?to=${encodeURIComponent(back)}`, appUrl));
    }
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    if (path !== "/") login.searchParams.set("next", path);
    return NextResponse.redirect(login);
  }
  response.headers.set("content-security-policy", csp);
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
