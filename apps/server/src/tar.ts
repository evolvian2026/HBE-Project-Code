import { gunzipSync } from "node:zlib";

/**
 * Regular files from a gzipped tarball (the source snapshots `git archive` writes: ustar with
 * pax headers for long paths). `want` picks files by path and size; others are skipped
 * without being decoded. Stops at `maxFiles` or `maxBytes` of kept content.
 */
export function readTarGz(
  gz: Buffer,
  want: (path: string, size: number) => boolean,
  { maxFiles = 2000, maxBytes = 8 * 1024 * 1024 } = {},
): { path: string; data: Buffer }[] {
  const tar = gunzipSync(gz, { maxOutputLength: 512 * 1024 * 1024 });
  const files: { path: string; data: Buffer }[] = [];
  let kept = 0;
  let longName: string | null = null;
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from: number, length: number) =>
      header
        .subarray(from, from + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const prefix = field(345, 155);
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;

    if (type === "x") {
      // pax extended header: "<length> path=<value>\n" records for the next entry.
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
      if (path) longName = path;
      continue;
    }
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    if (type !== "0" && type !== "7") continue;
    const path = name.replace(/^\.\//, "");
    if (!want(path, size)) continue;
    if (files.length >= maxFiles || kept + size > maxBytes) break;
    files.push({ path, data: Buffer.from(body) });
    kept += size;
  }
  return files;
}
