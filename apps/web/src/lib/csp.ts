/**
 * The pages' Content-Security-Policy. Scripts run only with this response's nonce (Next adds
 * it to its own scripts) or when loaded by one; the browser talks only to this site and to
 * Supabase (Realtime, and Storage for run screenshots). Styles allow inline style attributes.
 */
export function contentSecurityPolicy(nonce: string, supabaseUrl: string, dev = false): string {
  const supabase = new URL(supabaseUrl);
  const realtime = `${supabase.protocol === "https:" ? "wss:" : "ws:"}//${supabase.host}`;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // Run screenshots are redirected to signed Storage URLs.
    `img-src 'self' data: blob: ${supabase.origin}`,
    "font-src 'self'",
    `connect-src 'self' ${supabase.origin} ${realtime}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
