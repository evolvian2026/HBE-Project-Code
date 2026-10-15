import { NextResponse } from "next/server";

/**
 * A redirect to another address (the platform's, or an institution's). NextResponse.redirect
 * makes a URL on the server's own origin relative, which on an institution's address would
 * stay on that address; this always sends the full URL.
 */
export function redirectAcross(url: string | URL, status: 303 | 307 = 307): NextResponse {
  return new NextResponse(null, { status, headers: { location: url.toString() } });
}
