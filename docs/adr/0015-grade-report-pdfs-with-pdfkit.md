# 0015. Render grade report PDFs with PDFKit

Status: Accepted (2026-10-08)

## Context

Every released grade version needs an immutable report: canonical JSON (the record, hashed
with SHA-256) and a PDF for people. The design named `@react-pdf/renderer`. The worker shares
a 512 MB free-tier instance with the web and API roles, and the PDF is a plain document
(headings, labelled values, wrapped text), not a designed layout.

## Decision

Render the PDF with PDFKit 0.17 (pure JavaScript, built-in text wrapping and pagination) from
the same data as the JSON. Use the PDF standard fonts, which cover Western European text
(Windows-1252); other characters are replaced in the PDF only. The JSON stays the record and
keeps the exact text; the PDF prints the JSON's SHA-256.

## Consequences

- No React renderer, layout engine or WebAssembly in the worker; reports render in milliseconds.
- Names in non-Latin scripts (for example Chinese or Tamil) show as `?` in the PDF until a Unicode
  font is embedded (Noto Sans and Noto Sans CJK: about 20 MB, which is why it is deferred).
- Layout changes are code changes in `apps/server/src/reports/pdf.ts`.
