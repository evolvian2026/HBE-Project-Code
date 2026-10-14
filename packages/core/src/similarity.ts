/**
 * Similar code between submissions (Phase 3C), by winnowing (Schleimer, Wilkerson and Aiken,
 * "Winnowing: local algorithms for document fingerprinting", the method behind MOSS).
 *
 * Source is reduced to tokens with names, strings and numbers normalised (so renaming
 * variables or editing text doesn't hide copying, and comments and layout don't count), cut
 * into k-grams of tokens and hashed; each window of w hashes keeps its smallest, giving a
 * fingerprint that two files share wherever they share a passage of at least k + w − 1
 * tokens. Fingerprints of the starter code, and those most submissions share (boilerplate),
 * are ignored. Similar code is a reason to look, never proof: it never affects a grade.
 */

export interface SourceFile {
  path: string;
  text: string;
}

/** Tokens per k-gram, and k-grams per winnowing window. */
export const K = 12;
export const W = 8;
/** Fingerprints shared by at least this share of submissions (and 3 or more) are boilerplate. */
export const COMMON_SHARE = 0.4;
/** Pairs are reported from this similarity and this many shared fingerprints. */
export const MIN_SCORE = 0.25;
export const MIN_SHARED = 8;

const SOURCE = /\.(m?[jt]sx?|cjs|py|java|kt|cs|php|go|rb|rs|c|cc|cpp|h|hpp|swift|scala|vue|svelte)$/i;
const HASH_COMMENTS = /\.(py|rb)$/i;
/** Never compared: dependencies, build output, lock files, minified code. */
const SKIP =
  /(^|\/)(node_modules|vendor|dist|build|out|target|\.git|\.venv|venv|__pycache__|migrations|coverage)\/|\.min\.[jt]s$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

export const isComparable = (path: string) => SOURCE.test(path) && !SKIP.test(path);

const KEYWORDS = new Set(
  (
    "if else for while do switch case default break continue return function class extends new this super " +
    "try catch finally throw async await yield import export from as const let var static public private " +
    "protected interface implements enum typeof instanceof in of delete void null undefined true false " +
    "def elif lambda pass with global nonlocal assert raise except is not and or None True False self " +
    "package struct func go defer select chan map range type fn impl trait mut use mod match"
  ).split(" "),
);

interface Token {
  t: string;
  line: number;
}

/** The file as normalised tokens, each with its line. */
export function tokenize(text: string, path = ""): Token[] {
  const hash = HASH_COMMENTS.test(path);
  const out: Token[] = [];
  let line = 1;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      i++;
    } else if ((c === "/" && text[i + 1] === "/") || (hash && c === "#")) {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") line++;
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const start = line;
      const triple = hash && text.startsWith(c.repeat(3), i);
      const end = triple ? c.repeat(3) : c;
      i += end.length;
      while (i < n && !text.startsWith(end, i)) {
        if (text[i] === "\\") i++;
        else if (text[i] === "\n") {
          line++;
          if (!triple && c !== "`") break;
        }
        i++;
      }
      i += end.length;
      out.push({ t: "s", line: start });
    } else if (/[0-9]/.test(c)) {
      while (i < n && /[0-9A-Za-z_.]/.test(text[i]!)) i++;
      out.push({ t: "n", line });
    } else if (/[A-Za-z_$]/.test(c)) {
      const s = i;
      while (i < n && /[A-Za-z0-9_$]/.test(text[i]!)) i++;
      const word = text.slice(s, i);
      out.push({ t: KEYWORDS.has(word) ? word : "v", line });
    } else {
      out.push({ t: c, line });
      i++;
    }
  }
  return out;
}

/** 32-bit FNV-1a. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Position {
  path: string;
  /** Lines the fingerprinted passage spans. */
  from: number;
  to: number;
}

/** A submission's fingerprints: hash → where it occurs. */
export type Fingerprints = Map<number, Position[]>;

/** Winnowed fingerprints of a set of files. */
export function fingerprint(files: SourceFile[]): Fingerprints {
  const out: Fingerprints = new Map();
  for (const file of files) {
    if (!isComparable(file.path)) continue;
    const tokens = tokenize(file.text, file.path);
    if (tokens.length < K) continue;
    const grams: { h: number; from: number; to: number }[] = [];
    for (let i = 0; i + K <= tokens.length; i++) {
      let s = "";
      for (let j = i; j < i + K; j++) s += `${tokens[j]!.t}\u0001`;
      grams.push({ h: fnv(s), from: tokens[i]!.line, to: tokens[i + K - 1]!.line });
    }
    // Each window keeps its smallest hash (the rightmost on ties), once per position.
    let last = -1;
    for (let w = 0; w + W <= Math.max(grams.length, W); w++) {
      const end = Math.min(grams.length, w + W);
      let min = w;
      for (let j = w; j < end; j++) if (grams[j]!.h <= grams[min]!.h) min = j;
      if (min !== last) {
        last = min;
        const g = grams[min]!;
        const list = out.get(g.h) ?? [];
        list.push({ path: file.path, from: g.from, to: g.to });
        out.set(g.h, list);
      }
      if (end === grams.length) break;
    }
  }
  return out;
}

export interface Match {
  a: Position;
  b: Position;
  /** Shared fingerprints in this passage. */
  fingerprints: number;
}

export interface SimilarPair<Id> {
  a: Id;
  b: Id;
  /** 0–1: the share of the smaller submission's distinctive code also found in the other. */
  score: number;
  shared: number;
  /** Matching passages, longest first. */
  matches: Match[];
}

/** Merges matching fingerprints into passages: same files, lines close together. */
function passages(pairs: { a: Position; b: Position }[]): Match[] {
  const byFiles = new Map<string, { a: Position; b: Position }[]>();
  for (const p of pairs) {
    const key = `${p.a.path}\u0000${p.b.path}`;
    const list = byFiles.get(key) ?? [];
    list.push(p);
    byFiles.set(key, list);
  }
  const out: Match[] = [];
  for (const list of byFiles.values()) {
    list.sort((x, y) => x.a.from - y.a.from);
    let cur: Match | null = null;
    for (const p of list) {
      if (cur && p.a.from <= cur.a.to + 3 && Math.abs(p.b.from - cur.b.to) <= 12) {
        cur.a.to = Math.max(cur.a.to, p.a.to);
        cur.b.from = Math.min(cur.b.from, p.b.from);
        cur.b.to = Math.max(cur.b.to, p.b.to);
        cur.fingerprints++;
      } else {
        if (cur) out.push(cur);
        cur = { a: { ...p.a }, b: { ...p.b }, fingerprints: 1 };
      }
    }
    if (cur) out.push(cur);
  }
  return out.sort((x, y) => y.fingerprints - x.fingerprints || x.a.path.localeCompare(y.a.path));
}

/**
 * Compares every pair of submissions. `starter` is the starter code (its fingerprints never
 * count); fingerprints in at least COMMON_SHARE of the submissions (and 3 or more) don't
 * either. Returns the pairs at or above MIN_SCORE with MIN_SHARED fingerprints in common,
 * most similar first.
 */
export function similarPairs<Id>(
  submissions: { id: Id; fingerprints: Fingerprints }[],
  starter: Fingerprints = new Map(),
): SimilarPair<Id>[] {
  const holders = new Map<number, number>();
  for (const s of submissions) for (const h of s.fingerprints.keys()) holders.set(h, (holders.get(h) ?? 0) + 1);
  const commonAt = Math.max(3, Math.ceil(submissions.length * COMMON_SHARE));
  const distinctive = submissions.map((s) => ({
    id: s.id,
    prints: new Map([...s.fingerprints].filter(([h]) => !starter.has(h) && (holders.get(h) ?? 0) < commonAt)),
  }));

  const out: SimilarPair<Id>[] = [];
  for (let i = 0; i < distinctive.length; i++) {
    for (let j = i + 1; j < distinctive.length; j++) {
      const [x, y] = [distinctive[i]!, distinctive[j]!];
      const [small, large] = x.prints.size <= y.prints.size ? [x.prints, y.prints] : [y.prints, x.prints];
      if (small.size === 0) continue;
      let shared = 0;
      for (const h of small.keys()) if (large.has(h)) shared++;
      const score = shared / small.size;
      if (shared < MIN_SHARED || score < MIN_SCORE) continue;
      const located: { a: Position; b: Position }[] = [];
      for (const [h, as] of x.prints) {
        const bs = y.prints.get(h);
        if (bs) located.push({ a: as[0]!, b: bs[0]! });
      }
      out.push({ a: x.id, b: y.id, score: Math.round(score * 1000) / 1000, shared, matches: passages(located) });
    }
  }
  return out.sort((p, q) => q.score - p.score || q.shared - p.shared);
}
