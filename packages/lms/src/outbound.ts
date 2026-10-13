import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

/**
 * fetch for URLs an LMS or an institution's admin gave us (configuration, JWKS, token, line
 * item and roster URLs): it only reaches public internet addresses, so those URLs can't be used
 * to reach the platform's own network (cloud metadata, databases, internal services).
 *
 * The address is checked when the connection is made, after DNS resolution, so a name that
 * resolves to a public address when checked and a private one when used (DNS rebinding) is
 * refused too. Redirects are not followed, responses are capped in size and every request
 * times out.
 */
export interface OutboundPolicy {
  /** Local development only: allow http:// and private addresses (the stand-in LMS). */
  allowPrivate: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

export class OutboundRefused extends Error {
  readonly code = "outbound_refused";
}

const v4 = (a: string) => a.split(".").map(Number) as [number, number, number, number];

/** Whether an IP address is on the public internet (not private, loopback, link-local…). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = v4(address);
    return !(
      a === 0 || // "this" network
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) || // documentation
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224 // multicast, reserved, broadcast
    );
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (lower === "::" || lower === "::1") return false;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    return !(
      (first & 0xfe00) === 0xfc00 || // unique local
      (first & 0xffc0) === 0xfe80 || // link-local
      (first & 0xff00) === 0xff00 || // multicast
      lower.startsWith("64:ff9b:") || // NAT64 (can reach IPv4 private ranges)
      lower.startsWith("2001:db8:") // documentation
    );
  }
  return false;
}

/** DNS lookup that fails unless every address the name resolves to is public. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, "", 0);
    const refused = addresses.find((a) => !isPublicAddress(a.address));
    if (refused || addresses.length === 0) {
      return callback(new OutboundRefused(`${hostname} is not a public internet address`), "", 0);
    }
    if (options.all) return (callback as (e: null, a: LookupAddress[]) => void)(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

export function outboundFetch(policy: OutboundPolicy): typeof fetch {
  const timeoutMs = policy.timeoutMs ?? 15_000;
  const maxBytes = policy.maxBytes ?? 2 * 1024 * 1024;

  const guarded = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    if (input instanceof Request) throw new TypeError("outboundFetch takes a URL");
    const url = new URL(input);
    if (url.protocol !== "https:" && !(policy.allowPrivate && url.protocol === "http:")) {
      throw new OutboundRefused(`Only https:// URLs can be used (got ${url.protocol})`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // An address in the URL itself is connected to without a DNS lookup.
    if (!policy.allowPrivate && isIP(host) && !isPublicAddress(host)) {
      throw new OutboundRefused(`${host} is not a public internet address`);
    }

    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => (headers[key] = value));
    let body: string | undefined;
    if (typeof init.body === "string") body = init.body;
    else if (init.body instanceof URLSearchParams) {
      body = init.body.toString();
      headers["content-type"] ??= "application/x-www-form-urlencoded;charset=UTF-8";
    } else if (init.body != null) throw new TypeError("outboundFetch sends string or form bodies");
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));

    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;

    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = send(url, {
        method: init.method ?? "GET",
        headers,
        signal,
        ...(policy.allowPrivate ? {} : { lookup: publicLookup }),
      });
      req.on("response", resolve);
      req.on("error", reject);
      req.end(body);
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        throw new OutboundRefused(`The response from ${url.host} is larger than ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(key, v);
    }
    const status = res.statusCode ?? 502;
    return new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders });
  };
  return guarded as typeof fetch;
}
