import { readFileSync } from "node:fs";
import ts from "typescript";

// The ReDoS sweep (rulings W-T13-B18 and B19), shared by the battery files (src/lib/payables/amount.redos*.test.ts).
// For one regex it builds prefixes from the literal characters of its own source (every 1- to 3-character piece, in
// both cases, each literal chunk alone and closed by "#", ":" or a space, and two chunks written together), puts each
// before long runs of blanks, punctuation, letters and digits closed by a character that forces a mismatch, and times
// the regex on them:
//   1. at 24 characters first, so an exponential regex fails in milliseconds instead of hanging the file;
//   2. at 1,000 characters, so a cubic one fails before it meets a long run;
//   3. at 6,000 characters; a run of 12 ms or more there is confirmed at 20,000 characters (best of 3).
// A regex fails when a confirmation run takes LIMIT_MS or more (or a tiny or 1,000-character run is already over its
// limit). A linear regex takes a few milliseconds at 20,000 characters, even on a loaded machine.

export const LIMIT_MS = 150;
const TINY = 24;
const TINY_LIMIT_MS = 25;
const EARLY = 1_000;
const SIZE = 6_000;
const CANDIDATE_MS = 12;
const CONFIRM = 20_000;

export const RUN_UNITS = [
  " ",
  "\t",
  "\n",
  ":",
  "#",
  ".",
  "-",
  ",",
  "a",
  "1",
  "é",
  " :",
  "1,",
  "a ",
  "inv",
];
export const CLOSERS = ["x", "!"];

/** The literal characters of a regex source, as chunks: outside classes, group syntax and quantifiers removed. */
export function literalChunks(source: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inClass = false;
  const flush = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i] ?? "";
    if (c === "\\") {
      const d = source[i + 1] ?? "";
      i++;
      if (/[sdwSDWbBnrtupP]/.test(d)) {
        flush();
        if (d === "u") i += source[i + 1] === "{" ? source.indexOf("}", i) - i : 4;
        if (d === "p" || d === "P") i = source.indexOf("}", i);
        continue;
      }
      if (!inClass) cur += d;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      flush();
      inClass = true;
      continue;
    }
    if ("()|*+?{}^$.".includes(c)) {
      flush();
      if (c === "{") while (i < source.length && source[i] !== "}") i++;
      continue;
    }
    cur += c;
  }
  flush();
  return out.filter((x) => x.length > 0);
}

/** The prefixes a regex is swept with, built from its own literal characters. */
export function prefixesOf(re: RegExp): string[] {
  const chunks = literalChunks(re.source);
  const prefixes = new Set<string>([""]);
  for (const ch of chunks) {
    for (let a = 0; a < ch.length; a++) {
      for (let len = 1; len <= 3 && a + len <= ch.length; len++) {
        const g = ch.slice(a, a + len);
        prefixes.add(g);
        prefixes.add(g.toUpperCase());
        prefixes.add(g.toLowerCase());
      }
    }
    if (ch.length <= 12) {
      prefixes.add(ch);
      prefixes.add(ch.toUpperCase());
      prefixes.add(`${ch}#`);
      prefixes.add(`${ch}:`);
      prefixes.add(`${ch} `);
    }
  }
  // Two literal chunks written one after the other ("invoice" then "no").
  const small = chunks.filter((c) => c.length <= 8).slice(0, 8);
  for (const a of small) {
    for (const b of small) {
      if (a === b) continue;
      prefixes.add(a + b);
      prefixes.add(`${a} ${b}`);
    }
  }
  return [...prefixes];
}

function time(re: RegExp, text: string): number {
  re.lastIndex = 0;
  const t0 = performance.now();
  re.test(text);
  const ms = performance.now() - t0;
  re.lastIndex = 0;
  return ms;
}

function best3(re: RegExp, text: string): number {
  return Math.min(time(re, text), time(re, text), time(re, text));
}

const run = (prefix: string, unit: string, size: number, closer: string) =>
  `${prefix}${unit.repeat(Math.ceil(size / unit.length))}${closer}`;
const describeRun = (prefix: string, unit: string, size: number, closer: string) =>
  `${JSON.stringify(prefix)} + ${JSON.stringify(unit)} x ${size} + ${JSON.stringify(closer)}`;

/** The first slow shape of a regex ("<prefix> + <unit> x <size> + <closer>: <ms> ms"), or null when none is slow. */
export function checkRegex(
  re: RegExp,
  prefixes: readonly string[] = prefixesOf(re),
): string | null {
  // 1. Tiny runs: an exponential regex shows here.
  for (const p of prefixes) {
    for (const u of RUN_UNITS) {
      for (const c of CLOSERS) {
        const ms = time(re, run(p, u, TINY, c));
        if (ms >= TINY_LIMIT_MS && best3(re, run(p, u, TINY, c)) >= TINY_LIMIT_MS)
          return `${describeRun(p, u, TINY, c)}: ${ms.toFixed(0)} ms`;
      }
    }
  }
  // 2. and 3. 1,000 and 6,000 characters; a candidate is confirmed at 20,000.
  for (const p of prefixes) {
    for (const u of RUN_UNITS) {
      for (const c of CLOSERS) {
        const early = time(re, run(p, u, EARLY, c));
        if (early >= LIMIT_MS && best3(re, run(p, u, EARLY, c)) >= LIMIT_MS)
          return `${describeRun(p, u, EARLY, c)}: ${early.toFixed(0)} ms`;
        const ms = time(re, run(p, u, SIZE, c));
        if (ms < CANDIDATE_MS) continue;
        if (ms >= LIMIT_MS && best3(re, run(p, u, SIZE, c)) >= LIMIT_MS)
          return `${describeRun(p, u, SIZE, c)}: ${ms.toFixed(0)} ms`;
        const big = best3(re, run(p, u, CONFIRM, c));
        if (big >= LIMIT_MS) return `${describeRun(p, u, CONFIRM, c)}: ${big.toFixed(0)} ms`;
      }
    }
  }
  return null;
}

/** What the source of a module declares: its regex literals, and every RegExp construction and where it sits. */
export interface Scanned {
  /** Each regex literal anywhere in the file (functions too), compiled from its own text. */
  literals: { where: string; re: RegExp }[];
  /** Each `new RegExp(...)` or `RegExp(...)`: the top-level const it initialises, or the function it is in. */
  constructions: { where: string; topLevel: string | null; inFunction: string | null }[];
  /** For each function, the top-level consts whose initialiser calls it directly, and whether any other call exists. */
  calls: Map<string, { topLevel: string[]; other: number }>;
}

export function scanModule(url: URL, name: string): Scanned {
  const text = readFileSync(url, "utf8");
  const src = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const lineOf = (n: ts.Node) => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;
  const literals: Scanned["literals"] = [];
  const constructions: Scanned["constructions"] = [];
  const calls: Scanned["calls"] = new Map();
  const isRegExpCall = (n: ts.Node): boolean =>
    (ts.isNewExpression(n) || ts.isCallExpression(n)) && n.expression.getText(src) === "RegExp";
  /** The name of the function or arrow function a node sits in, or null at the top level. */
  const enclosing = (n: ts.Node): string | null => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p)) return p.name?.getText(src) ?? "(function)";
      if (ts.isArrowFunction(p) || ts.isFunctionExpression(p) || ts.isMethodDeclaration(p)) {
        const holder = p.parent;
        return holder && ts.isVariableDeclaration(holder) ? holder.name.getText(src) : "(function)";
      }
    }
    return null;
  };
  /** The top-level const a node initialises directly (the whole initialiser), or null. */
  const topLevelOf = (n: ts.Node): string | null => {
    const d = n.parent;
    if (!d || !ts.isVariableDeclaration(d) || d.initializer !== n) return null;
    const statement = d.parent?.parent;
    return statement && ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent)
      ? d.name.getText(src)
      : null;
  };
  const visit = (n: ts.Node) => {
    if (ts.isRegularExpressionLiteral(n)) {
      const t = n.text;
      const end = t.lastIndexOf("/");
      literals.push({
        where: `${name}:${lineOf(n)}`,
        re: new RegExp(t.slice(1, end), t.slice(end + 1)),
      });
    }
    if (isRegExpCall(n)) {
      constructions.push({
        where: `${name}:${lineOf(n)}`,
        topLevel: topLevelOf(n),
        inFunction: enclosing(n),
      });
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const callee = n.expression.getText(src);
      const entry = calls.get(callee) ?? { topLevel: [], other: 0 };
      const top = topLevelOf(n);
      if (top !== null) entry.topLevel.push(top);
      else entry.other++;
      calls.set(callee, entry);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return { literals, constructions, calls };
}

/** Every regex once (by flags and source), with where it is declared. */
export function distinct(
  list: readonly { where: string; re: RegExp }[],
): { where: string; re: RegExp }[] {
  const seen = new Map<string, { where: string; re: RegExp }>();
  for (const r of list) {
    const key = `${r.re.flags}/${r.re.source}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

/**
 * Every RegExp the reader and the lexicon declare, once: the literals of both sources, and the top-level regexes the
 * reader builds at run time (`namespace`, its REGEXES_FOR_TESTS).
 */
export function readerRegexes(
  payables: URL,
  namespace: Readonly<Record<string, RegExp>>,
): { where: string; re: RegExp }[] {
  const amount = scanModule(new URL("amount.ts", payables), "amount.ts");
  const lexicon = scanModule(new URL("lexicon.ts", payables), "lexicon.ts");
  return distinct([
    ...amount.literals,
    ...lexicon.literals,
    ...Object.entries(namespace).map(([n, re]) => ({ where: `amount.ts ${n}`, re })),
  ]);
}
