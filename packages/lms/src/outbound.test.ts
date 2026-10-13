import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPublicAddress, outboundFetch, OutboundRefused } from "./outbound.ts";

describe("isPublicAddress", () => {
  it.each([
    ["8.8.8.8", true],
    ["151.101.1.69", true],
    ["2606:4700:4700::1111", true],
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.16.0.1", false],
    ["172.31.255.255", false],
    ["172.32.0.1", true],
    ["192.168.1.1", false],
    ["169.254.169.254", false], // cloud metadata
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["::1", false],
    ["::", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:8.8.8.8", true],
    ["64:ff9b::a00:1", false],
    ["not-an-ip", false],
  ])("%s → %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe("outboundFetch", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/big") return res.end("x".repeat(5000));
      if (req.url === "/moved") return res.writeHead(302, { location: "http://169.254.169.254/" }).end();
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json", "x-seen": req.headers["x-test"] ?? "" });
        res.end(JSON.stringify({ method: req.method, body, type: req.headers["content-type"] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses private addresses and plain http outside local development", async () => {
    const strict = outboundFetch({ allowPrivate: false });
    await expect(strict(`${base}/`)).rejects.toBeInstanceOf(OutboundRefused); // http
    await expect(strict("https://127.0.0.1/")).rejects.toThrow("not a public internet address");
    await expect(strict("https://[::1]/")).rejects.toThrow("not a public internet address");
    await expect(strict("https://169.254.169.254/latest/meta-data/")).rejects.toThrow("not a public");
    // A name that resolves to a private address is refused when connecting.
    await expect(strict("https://localhost/")).rejects.toThrow("not a public internet address");
  });

  it("sends the request and returns a normal Response", async () => {
    const local = outboundFetch({ allowPrivate: true });
    const res = await local(`${base}/echo`, {
      method: "POST",
      headers: { "x-test": "yes" },
      body: new URLSearchParams({ a: "1" }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-seen")).toBe("yes");
    expect(await res.json()).toEqual({
      method: "POST",
      body: "a=1",
      type: "application/x-www-form-urlencoded;charset=UTF-8",
    });
  });

  it("doesn't follow redirects, and caps the response size", async () => {
    const local = outboundFetch({ allowPrivate: true, maxBytes: 1000 });
    const moved = await local(`${base}/moved`);
    expect(moved.status).toBe(302);
    await expect(local(`${base}/big`)).rejects.toThrow("larger than 1000 bytes");
  });

  it("times out", async () => {
    const slow = createServer(() => {}); // never answers
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const port = (slow.address() as { port: number }).port;
    const local = outboundFetch({ allowPrivate: true, timeoutMs: 200 });
    await expect(local(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    slow.closeAllConnections();
    await new Promise<void>((r) => slow.close(() => r()));
  });
});
