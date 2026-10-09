import type { FastifyReply } from "fastify";

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1d2433}
h1{font-size:1.25rem}fieldset{border:1px solid #d5dae3;border-radius:6px;margin:0 0 1rem;padding:.75rem 1rem}
legend{font-weight:600;padding:0 .25rem}label{display:flex;gap:.5rem;align-items:baseline;margin:.35rem 0}
small{color:#5b6475}button{font:inherit;background:#2456d3;color:#fff;border:0;border-radius:6px;padding:.5rem 1rem;cursor:pointer}`;

/**
 * A small page for the browser: LTI requests are navigations from the LMS (often inside its
 * frame), not API calls. `bodyHtml` must already be escaped.
 */
export function page(reply: FastifyReply, status: number, title: string, message: string, bodyHtml = "") {
  return reply
    .code(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head>
<body><h1>${escapeHtml(title)}</h1>${message ? `<p>${escapeHtml(message)}</p>` : ""}${bodyHtml}</body></html>`,
    );
}
