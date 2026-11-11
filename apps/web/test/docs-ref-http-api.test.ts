import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isLinkCode } from "@/lib/alerts/links";
import { CHALLENGE_TTL_MS } from "@/lib/auth/challenge";
import { SESSION_TTL_MS } from "@/lib/auth/session";
import { cronAuthorized } from "@/lib/cron";
import { HTTP_ERRORS } from "@/lib/docs/errors";
import { TABLES } from "@/lib/docs/ref/http-api";
import { type RefRow, ROW_ID } from "@/lib/docs/ref/types";
import { findPage } from "@/lib/docs/registry";
import { newPairCode, newToken, showCode, TOKEN_RE } from "@/lib/ext/token";
import { HEALTH_CACHE_MS, HEALTH_TIMEOUT_MS } from "@/lib/health";
import { clientIp } from "@/lib/http";
import { MAX_INVOICE_BYTES } from "@/lib/payables/limits";
import { ledgerFileName } from "@/lib/proof/ledger-file";
import { PAYMENTS_COLUMNS, paymentsCsv, paymentsCsvFileName } from "@/lib/proof/payments-csv";
import { snapshotFileName } from "@/lib/proof/snapshot-file";
import { LIMITS } from "@/lib/ratelimit";
import { readMdx, WEB, walkFiles } from "./docs-helpers";

// The HTTP API page is pinned to the route files: every exported method of every
// src/app/api/**/route.ts, and of the proof page's files in src/app/proof/**/route.ts, is a row and
// every row is one, and each row's caller, error codes, rate
// limits, what each limit counts and the fields of a success answer the route writes out are what
// the code reads. The scan reads the source text, never the rows, so a route, a method, a code or a
// limit added to the code fails here and names itself.

const API = join(WEB, "src", "app", "api");
/** The proof page's files (snapshot.json, ledger.jsonl, payments.csv): served under /proof, not /api. */
const PROOF = join(WEB, "src", "app", "proof");
/** Every method a Next.js route handler may export. */
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

const texts = new Map<string, string>();
/** A file's text, read once. A self-test may put a file of its own here. */
function read(file: string): string {
  let text = texts.get(file);
  if (text === undefined) {
    text = readFileSync(file, "utf8");
    texts.set(file, text);
  }
  return text;
}
const exists = (file: string) => texts.has(file) || existsSync(file);
const src = (path: string) => read(join(WEB, path));
const rel = (file: string) => relative(WEB, file).split(sep).join("/");
const esc = (s: string) => s.replace(/[$]/g, "\\$");

/** The HTTP methods a route module exports: functions, consts and `export { x as GET }`. */
function methodsOf(text: string): string[] {
  const found = new Set<string>();
  const named = METHODS.join("|");
  for (const m of text.matchAll(
    new RegExp(`export\\s+(?:async\\s+)?function\\s+(${named})\\b`, "g"),
  ))
    found.add(m[1] ?? "");
  for (const m of text.matchAll(new RegExp(`export\\s+(?:const|let|var)\\s+(${named})\\b`, "g")))
    found.add(m[1] ?? "");
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name =
        part
          .trim()
          .split(/\s+as\s+/)
          .pop() ?? "";
      if ((METHODS as readonly string[]).includes(name)) found.add(name);
    }
  }
  return [...found].sort();
}

/** The URL path of a route file: `[vault]` is `:vault`, a catch-all is `:slug*`, a `(group)` is left out. */
function urlOf(dir: string, base = "/api"): string {
  const segments = dir
    .split(/[\\/]/)
    .filter((s) => s !== "" && !/^\(.*\)$/.test(s))
    .map((s) => s.replace(/^\[\[?\.\.\.(\w+)\]\]?$/, ":$1*").replace(/^\[(\w+)\]$/, ":$1"));
  return `${base}/${segments.join("/")}`;
}

/**
 * A row's anchor: the area, the method and the path after /api, as in `http-api-post-auth-verify`. A proof file's
 * keeps `proof` and writes its dot as a dash: `http-api-get-proof-vault-payments-csv`.
 */
function rowIdOf(method: string, url: string): string {
  const parts = url.split("/").filter(Boolean);
  const path = (parts[0] === "api" ? parts.slice(1) : parts).map((s) =>
    s.replace(/^:/, "").replace(/\*$/, "").replace(/\./g, "-"),
  );
  return ["http-api", method.toLowerCase(), ...path].join("-");
}

/** The group of a route: the first segment after /api, or "proof" for a proof file. */
const groupOf = (url: string): string =>
  (url.startsWith("/api/") ? url.split("/")[2] : url.split("/")[1]) ?? "";

/** Every route file, with its "METHOD /api/..." or "METHOD /proof/..." keys. */
const ROUTES = (
  [
    [API, "/api"],
    [PROOF, "/proof"],
  ] as const
).flatMap(([root, base]) =>
  walkFiles(root, ".ts")
    .filter((f) => basename(f) === "route.ts")
    .flatMap((file) => {
      const text = read(file);
      const url = urlOf(relative(root, dirname(file)), base);
      return methodsOf(text).map((method) => ({
        key: `${method} ${url}`,
        method,
        url,
        file,
        text,
      }));
    }),
);

// Source text, read with strings, templates and comments skipped, so a bracket in a message or a
// quote in a comment does not move a boundary.

/** The last index of the string, template or comment that starts at `i`, or `i` when none does. */
function skipLiteral(text: string, i: number): number {
  const c = text.charAt(i);
  const next = text.charAt(i + 1);
  if (c === "/" && next === "/") {
    const end = text.indexOf("\n", i);
    return end === -1 ? text.length - 1 : end;
  }
  if (c === "/" && next === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length - 1 : end + 1;
  }
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < text.length; j++) {
      if (text.charAt(j) === "\\") j++;
      else if (text.charAt(j) === c || text.charAt(j) === "\n") return j;
    }
    return text.length - 1;
  }
  if (c === "`") {
    for (let j = i + 1; j < text.length; j++) {
      const k = text.charAt(j);
      if (k === "\\") j++;
      else if (k === "`") return j;
      else if (k === "$" && text.charAt(j + 1) === "{") j = closeOf(text, j + 1);
    }
    return text.length - 1;
  }
  return i;
}

/**
 * `text` at the same length, with every comment and the inside of every string blanked out: a template keeps its
 * `${...}` code. The scan's patterns run on this, and read what they find from `text` at the same place.
 */
function codeOnly(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k <= to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  /** Walks code from `i`; inside a template's `${`, stops at its closing `}` and returns its index. */
  const walk = (start: number, inTemplate: boolean): number => {
    let depth = 0;
    let i = start;
    for (; i < text.length; i++) {
      const c = text.charAt(i);
      const next = text.charAt(i + 1);
      if (c === "/" && (next === "/" || next === "*")) {
        const end = skipLiteral(text, i);
        blank(i, end);
        i = end;
      } else if (c === '"' || c === "'") {
        const end = skipLiteral(text, i);
        blank(i + 1, end - 1);
        i = end;
      } else if (c === "`") {
        for (i++; i < text.length; i++) {
          const k = text.charAt(i);
          if (k === "\\") {
            blank(i, i + 1);
            i++;
          } else if (k === "`") break;
          else if (k === "$" && text.charAt(i + 1) === "{") i = walk(i + 2, true);
          else blank(i, i);
        }
      } else if (inTemplate && c === "{") depth++;
      else if (inTemplate && c === "}") {
        if (depth === 0) return i;
        depth--;
      }
    }
    return i;
  };
  walk(0, false);
  return out.join("");
}

const masks = new Map<string, string>();
/** A file's `codeOnly` text, worked out once. */
function maskOf(file: string): string {
  let mask = masks.get(file);
  if (mask === undefined) {
    mask = codeOnly(read(file));
    masks.set(file, mask);
  }
  return mask;
}

/** The index of the bracket that closes the one at `open`, or the last index of the text. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const skipped = skipLiteral(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = text.charAt(i);
    if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && --depth === 0) return i;
  }
  return text.length - 1;
}

/** The top-level parts of the bracket at `open`, split at its commas: a call's arguments, an object's entries. */
function partsAt(text: string, open: number): string[] {
  const end = closeOf(text, open);
  const out: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < end; i++) {
    const skipped = skipLiteral(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = text.charAt(i);
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start, end).trim());
  return out.filter((p) => p !== "");
}

/** The text from `start` to the end of its statement: a `;` or a new line that starts a statement. */
function statementAt(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const skipped = skipLiteral(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = text.charAt(i);
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === ";") return text.slice(start, i);
    else if (depth === 0 && c === "\n" && i > start + 1 && /[A-Za-z@/]/.test(text.charAt(i + 1)))
      return text.slice(start, i);
  }
  return text.slice(start);
}

/** The body of the function whose parameters open at or after `from`, or null. */
function functionAt(text: string, from: number): string | null {
  const open = text.indexOf("(", from);
  if (open === -1) return null;
  let i = closeOf(text, open);
  // Past the parameters: a return type may hold braces (`{ jwt: string } | Response`), so the body is
  // the first `{` at type depth 0 that does not follow `:`, `|`, `&`, `<`, `,`, `(` or `=`.
  let depth = 0;
  for (i++; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === "=" && text.charAt(i + 1) === ">") {
      i++;
      continue;
    }
    if (c === "{" && depth === 0 && !/[:|&<,(=]$/.test(text.slice(0, i).trimEnd())) break;
    if ("<({[".includes(c)) depth++;
    else if (">)}]".includes(c)) depth--;
  }
  if (i >= text.length) return null;
  return text.slice(i, closeOf(text, i) + 1);
}

/** `function name(...) { ... }`: its body, or null. */
function functionOf(text: string, name: string): string | null {
  const m = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${esc(name)}\\s*[<(]`,
  ).exec(text);
  return m ? functionAt(text, m.index + m[0].length - 1) : null;
}

/** `const name = (...) => ...` or `const name = function ...`: the whole statement, or null. */
function arrowOf(text: string, name: string): string | null {
  const m = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${esc(name)}\\b[^=;]*=\\s*(?:async\\s+)?(?:function\\b|\\(|<|[A-Za-z_$][\\w$]*\\s*=>)`,
  ).exec(text);
  return m ? statementAt(text, m.index) : null;
}

/** `class name { ... }`: its body, or null. */
function classOf(text: string, name: string): string | null {
  const m = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${esc(name)}\\b[^{]*\\{`,
  ).exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  return text.slice(open, closeOf(text, open) + 1);
}

/** A module an import names, when it is a file of this app: `@/...` or a relative path. */
function resolveModule(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(WEB, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = join(dirname(from), spec);
  else return null;
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (exists(c)) return c;
  return null;
}

interface Target {
  file: string;
  /** The exported name, or "default". */
  name: string;
}

/** What a module imports from this app's files: named and default imports by local name, and `* as` namespaces. */
function importsOf(file: string): { named: Map<string, Target>; namespaces: Map<string, string> } {
  const named = new Map<string, Target>();
  const namespaces = new Map<string, string>();
  for (const m of read(file).matchAll(
    /(?:^|\n)\s*import\s+(type\s+)?([^"';]*?)\s*from\s*"([^"]+)"/g,
  )) {
    if (m[1]) continue;
    const target = resolveModule(m[3] ?? "", file);
    if (target === null) continue;
    const clause = (m[2] ?? "").trim();
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause)?.[1];
    if (def) named.set(def, { file: target, name: "default" });
    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
    if (ns) namespaces.set(ns, target);
    for (const part of /\{([^}]*)\}/.exec(clause)?.[1]?.split(",") ?? []) {
      const p = part.trim();
      if (p === "" || p.startsWith("type ")) continue;
      const [name = "", local] = p.split(/\s+as\s+/).map((s) => s.trim());
      named.set(local ?? name, { file: target, name });
    }
  }
  return { named, namespaces };
}

/** The `{ a, b as c }` lists of a module's `export { ... }` lines, with the module each one re-exports from. */
function exportListsOf(text: string): { names: [string, string][]; from: string | null }[] {
  return [...text.matchAll(/export\s*\{([^}]*)\}(\s*from\s*"([^"]+)")?/g)].map((m) => ({
    names: (m[1] ?? "")
      .split(",")
      .map((p) => p.trim().replace(/^type\s+/, ""))
      .filter((p) => p !== "")
      .map((p) => {
        const [orig = "", alias] = p.split(/\s+as\s+/).map((s) => s.trim());
        return [orig, alias ?? orig] as [string, string];
      }),
    from: m[3] ?? null,
  }));
}

/**
 * Where `target` is defined, following `export { } from`, `export *`, an import that is exported again and a
 * default export: the body the scan reads, or null with the module the search ended in.
 */
function definition(target: Target, hops = 0): { file: string; body: string | null } {
  const { file, name } = target;
  const text = read(file);
  if (hops > 8) return { file, body: null };
  if (name === "default") {
    const fn =
      /(?:^|\n)\s*export\s+default\s+(?:async\s+)?function\b\s*\*?\s*[A-Za-z_$]?[\w$]*\s*[<(]/.exec(
        text,
      );
    if (fn) return { file, body: functionAt(text, fn.index + fn[0].length - 1) };
    const cls = /(?:^|\n)\s*export\s+default\s+(?:abstract\s+)?class\b[^{]*\{/.exec(text);
    if (cls) {
      const open = cls.index + cls[0].length - 1;
      return { file, body: text.slice(open, closeOf(text, open) + 1) };
    }
    const arrow = /(?:^|\n)\s*export\s+default\s+(?:async\s+)?(?:\(|[A-Za-z_$][\w$]*\s*=>)/.exec(
      text,
    );
    if (arrow) return { file, body: statementAt(text, arrow.index) };
    const ref = /(?:^|\n)\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;/.exec(text)?.[1];
    if (ref) return definition({ file, name: ref }, hops + 1);
    for (const list of exportListsOf(text)) {
      for (const [orig, alias] of list.names) {
        if (alias !== "default") continue;
        const next = list.from === null ? file : resolveModule(list.from, file);
        if (next) return definition({ file: next, name: orig }, hops + 1);
      }
    }
    return { file, body: null };
  }
  const body = functionOf(text, name) ?? arrowOf(text, name) ?? classOf(text, name);
  if (body !== null) return { file, body };
  for (const list of exportListsOf(text)) {
    for (const [orig, alias] of list.names) {
      if (alias !== name) continue;
      if (list.from !== null) {
        const next = resolveModule(list.from, file);
        if (next) return definition({ file: next, name: orig }, hops + 1);
      } else if (orig !== name) return definition({ file, name: orig }, hops + 1);
    }
  }
  const imported = importsOf(file).named.get(name);
  if (imported) return definition(imported, hops + 1);
  for (const m of text.matchAll(/export\s+\*\s+from\s*"([^"]+)"/g)) {
    const next = resolveModule(m[1] ?? "", file);
    if (next === null) continue;
    const found = definition({ file: next, name }, hops + 1);
    if (found.body !== null) return found;
  }
  return { file, body: null };
}

interface Scan {
  /** "status code" pairs from literal `problem()` calls and `json({ error }, status)` answers. */
  pairs: Set<string>;
  /** `problem()` calls and `json()` errors whose status or code is not a literal. */
  dynamic: Set<string>;
  /** `LIMITS.<key>` names. */
  limits: Set<string>;
  /** Each `LIMITS.<key>` passed as a limit, with the bucket key passed before it. */
  buckets: { key: string; bucket: string; file: string }[];
  /** Calls into a module that answers, whose definition the scan cannot find. */
  missing: Set<string>;
}

const newScan = (): Scan => ({
  pairs: new Set(),
  dynamic: new Set(),
  limits: new Set(),
  buckets: [],
  missing: new Set(),
});

const PROBLEM_CALL = /(?<!function\s+)\bproblem\s*\(/g;
const JSON_CALL = /(?<![.\w$]|function\s+)json\s*\(/g;
const LITERAL_STATUS = /^\d{3}$/;
const LITERAL_CODE = /^"[a-z_]+"$/;

/**
 * What an answer's data sets `error` to, wherever the key stands in the object (or in either branch of a `? :`):
 * `"code"`, an expression, or `error` for the bare `{ error }`.
 */
function errorsIn(data: string): string[] {
  const mask = codeOnly(data);
  const values: string[] = [];
  for (const m of mask.matchAll(/(?:^|[{,\s])error\s*:\s*/g)) {
    const start = m.index + m[0].length;
    let end = start;
    let depth = 0;
    for (; end < mask.length; end++) {
      const c = mask.charAt(end);
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
    }
    values.push(data.slice(start, end).trim());
  }
  if (/(?:^|[{,])\s*error\s*(?=[,}])/.test(mask)) values.push("error");
  return values;
}

/** The argument before the one at `at` in its call or tuple, or null when `at` starts the list. */
function argBefore(text: string, at: number): string | null {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text.charAt(i))) i--;
  if (text.charAt(i) !== ",") return null;
  const end = i;
  let depth = 0;
  for (i--; i >= 0; i--) {
    const c = text.charAt(i);
    if (c === "`" || c === '"' || c === "'") {
      i = text.lastIndexOf(c, i - 1);
      continue;
    }
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  return text.slice(i + 1, end).trim();
}

function scanText(text: string, file: string, acc: Scan): void {
  const mask = codeOnly(text);
  for (const m of mask.matchAll(PROBLEM_CALL)) {
    const [status = "", code = ""] = partsAt(text, m.index + m[0].length - 1);
    if (LITERAL_STATUS.test(status) && LITERAL_CODE.test(code))
      acc.pairs.add(`${status} ${code.slice(1, -1)}`);
    else acc.dynamic.add(`${rel(file)}: problem(${status}, ${code})`);
  }
  for (const m of mask.matchAll(JSON_CALL)) {
    const [data = "", status = "200"] = partsAt(text, m.index + m[0].length - 1);
    for (const code of errorsIn(data)) {
      if (LITERAL_STATUS.test(status) && LITERAL_CODE.test(code))
        acc.pairs.add(`${status} ${code.slice(1, -1)}`);
      else acc.dynamic.add(`${rel(file)}: json({ error: ${code} }, ${status})`);
    }
  }
  // A key passed as a limit, after its bucket key; `LIMITS.x[0]` reads a number and passes no limit.
  for (const m of mask.matchAll(/\bLIMITS\.(\w+)(?!\s*[[.\w])/g)) {
    const bucket = argBefore(text, m.index);
    if (bucket !== null) acc.buckets.push({ key: m[1] ?? "", bucket, file });
  }
  for (const m of mask.matchAll(/\bLIMITS\.(\w+)/g)) acc.limits.add(m[1] ?? "");
}

const answering = new Map<string, boolean>();
/** True for a module that builds an error answer itself: a `problem()` call or a `json()` with an `error`. */
function answers(file: string): boolean {
  let found = answering.get(file);
  if (found === undefined) {
    const acc = newScan();
    scanText(read(file), file, acc);
    found = acc.pairs.size + acc.dynamic.size > 0;
    answering.set(file, found);
  }
  return found;
}

/** The answer builders themselves: their bodies name no answer of their own. */
const BUILDERS = new Set(["problem", "json"]);
const CALL = /\b([A-Za-z_$][\w$]*)\s*(?:<[^<>()=;]*>)?\s*\(/g;
const MEMBER_CALL = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*(?:<[^<>()=;]*>)?\s*\(/g;

/**
 * Follows the calls in `text` into the functions this app defines (imported by name, by default or through a
 * namespace, re-exported, or in the same module; declared as a function, an arrow const or a class), depth first, and
 * scans each body once. A call into a module that answers, whose definition it cannot find, is `missing`, so a helper
 * the scan cannot read fails the test instead of passing unread.
 */
function scanCalls(text: string, file: string, acc: Scan, seen: Set<string>, depth = 0): void {
  if (depth > 8) return;
  const { named, namespaces } = importsOf(file);
  const own = maskOf(file);
  const calls = codeOnly(text);
  const targets: Target[] = [];
  for (const m of calls.matchAll(CALL)) {
    const name = m[1] ?? "";
    if (BUILDERS.has(name)) continue;
    const target =
      named.get(name) ??
      (new RegExp(`(?:function\\s*\\*?|class|const|let|var)\\s+${esc(name)}\\b`).test(own)
        ? { file, name }
        : undefined);
    if (target) targets.push(target);
  }
  for (const m of calls.matchAll(MEMBER_CALL)) {
    const ns = namespaces.get(m[1] ?? "");
    if (ns) targets.push({ file: ns, name: m[2] ?? "" });
  }
  for (const target of targets) {
    const key = `${target.file}#${target.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const found = definition(target);
    if (found.body === null) {
      if (target.file !== file && answers(found.file))
        acc.missing.add(`${rel(file)}: ${target.name} from ${rel(found.file)}`);
      continue;
    }
    scanText(found.body, found.file, acc);
    scanCalls(found.body, found.file, acc, seen, depth + 1);
  }
}

function scanRoute(file: string): Scan {
  const acc = newScan();
  scanText(read(file), file, acc);
  scanCalls(read(file), file, acc, new Set());
  return acc;
}

/** The two answers whose code is a variable, read from the source that sets it. */
const SIGN_IN_FAILURE = "problem(401, result.reason)";
const CANARY_REJECTION = "problem(STATUS[r.reason], r.reason)";

function signInPairs(): string[] {
  const login = /export type LoginResult =[\s\S]*?reason:([^;]*);/.exec(
    src("src/lib/auth/verify.ts"),
  )?.[1];
  expect(login, "LoginResult's reasons in lib/auth/verify.ts").toBeDefined();
  const reasons = [...(login ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? "");
  expect(reasons, "the sign-in failure reasons").toContain("verifier_unavailable");
  // verifier_unavailable is answered as 503 unavailable, a literal call of its own.
  return reasons.filter((r) => r !== "verifier_unavailable").map((r) => `401 ${r}`);
}

function canaryPairs(text: string): string[] {
  const map = /const STATUS = \{([^}]*)\}/.exec(text)?.[1] ?? "";
  const pairs = [...map.matchAll(/(\w+):\s*(\d{3})/g)].map((m) => `${m[2]} ${m[1]}`);
  expect(pairs.length, "the Canary route's STATUS map").toBeGreaterThan(0);
  return pairs;
}

/**
 * Answers a helper gives that a route turns into another one. The faucet answers 404 for a member
 * who is not the owner and for a vault on the other network, so a vault id is never confirmed.
 */
const REMAPPED: Record<string, { shows: RegExp; drop: readonly string[] }> = {
  "POST /api/topup/faucet": {
    shows: /auth\.status === 401 \? auth : notFound\(\)/,
    drop: ["403 forbidden", "409 wrong_network"],
  },
};

/** topupLimited("quote") takes the `LIMITS` key and the bucket key the gate's BUCKETS name for "quote". */
const TOPUP_BUCKETS = new Map(
  [
    ...src("src/lib/topup/gate.ts").matchAll(
      /(\w+):\s*\([^)]*\)\s*=>\s*\[\s*([^\]]*?),\s*LIMITS\.(\w+)\s*\]/g,
    ),
  ].map((m) => [m[1] ?? "", { key: m[3] ?? "", bucket: (m[2] ?? "").trim() }]),
);

/** The parts a bucket key is made of, and the words the Rate limit cell uses for each. */
const BUCKET_PARTS: { part: RegExp; words: "IP address" | "account" | "vault" | "network" | "" }[] =
  [
    { part: /\bclientIp\(|\bipHash\b|\bip\b/, words: "IP address" },
    { part: /\baccount(?:Id|_id)?\b/, words: "account" },
    { part: /\bvault(?:_id)?\b|\btenant_id\b/, words: "vault" },
    { part: /\bnetwork\b/, words: "network" },
    // The faucet's counters are named for the UTC day: the window, not what is counted.
    { part: /^day$/, words: "" },
  ];

/** What a bucket counts, as the Rate limit cell says it: "per IP address", "per account and network", "in all". */
function scopeOf(bucket: string, file: string): string {
  let key = bucket;
  // FAUCET_BUCKETS.tries(account): the template the module's FAUCET_BUCKETS gives for `tries`.
  const ref = /^(\w+)\.(\w+)\(/.exec(key);
  if (ref) {
    const template = new RegExp(`\\b${ref[2]}:\\s*\\([^)]*\\)\\s*=>\\s*(\`[^\`]*\`)`).exec(
      read(file),
    )?.[1];
    expect(template, `${rel(file)}: the bucket key of ${bucket}`).toBeDefined();
    key = template ?? "";
  }
  if (/^"[^"]*"$/.test(key)) return "in all";
  expect(key, `${rel(file)}: a bucket key the test can read`).toMatch(/^`[^`]*`$/);
  const words = new Set<string>();
  for (const m of key.matchAll(/\$\{([^}]*)\}/g)) {
    const part = (m[1] ?? "").trim();
    const kind = BUCKET_PARTS.find((p) => p.part.test(part));
    expect(kind, `${rel(file)}: the part \${${part}} of ${bucket}`).toBeDefined();
    if (kind?.words) words.add(kind.words);
  }
  const who = (["IP address", "account", "vault"] as const).filter((w) => words.has(w));
  const network = words.has("network");
  if (who.length === 0) return network ? "per network" : "in all";
  return `per ${who.join(" and ")}${network ? " and network" : ""}`;
}

type Expected = {
  pairs: Set<string>;
  limits: Set<string>;
  scopes: Map<string, Set<string>>;
  dynamic: Set<string>;
  missing: Set<string>;
};
const expectations = new Map<string, Expected>();

/** What the code says about one route, worked out once. */
function expected(route: (typeof ROUTES)[number]): Expected {
  let found = expectations.get(route.key);
  if (found === undefined) {
    found = readExpected(route);
    expectations.set(route.key, found);
  }
  return found;
}

function readExpected(route: (typeof ROUTES)[number]): Expected {
  const scan = scanRoute(route.file);
  const pairs = new Set(scan.pairs);
  if (route.text.includes(SIGN_IN_FAILURE)) {
    expect(route.text).toContain('result.reason === "verifier_unavailable"');
    for (const p of signInPairs()) pairs.add(p);
  }
  if (route.text.includes(CANARY_REJECTION)) for (const p of canaryPairs(route.text)) pairs.add(p);
  const remap = REMAPPED[route.key];
  if (remap) for (const p of remap.drop) pairs.delete(p);
  const limits = new Set(scan.limits);
  const buckets = [...scan.buckets];
  for (const m of route.text.matchAll(/\btopupLimited\(\s*"(\w+)"/g)) {
    const entry = TOPUP_BUCKETS.get(m[1] ?? "");
    expect(entry, `${route.key}: topupLimited("${m[1]}") in lib/topup/gate.ts`).toBeDefined();
    if (entry) {
      limits.add(entry.key);
      buckets.push({ ...entry, file: join(WEB, "src", "lib", "topup", "gate.ts") });
    }
  }
  const scopes = new Map<string, Set<string>>();
  for (const b of buckets) {
    const set = scopes.get(b.key) ?? new Set<string>();
    set.add(scopeOf(b.bucket, b.file));
    scopes.set(b.key, set);
  }
  return { pairs, limits, scopes, dynamic: scan.dynamic, missing: scan.missing };
}

/**
 * The top-level fields of each success answer a route module writes out as an object literal: a `json({ ... })`
 * whose status is 2xx (or may be) and that sets no `error`. A spread is left out.
 */
function successKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const m of codeOnly(text).matchAll(JSON_CALL)) {
    const [data = "", status = "200"] = partsAt(text, m.index + m[0].length - 1);
    if (!data.startsWith("{") || errorsIn(data).length > 0) continue;
    if (!/\b2\d\d\b/.test(status)) continue;
    for (const entry of partsAt(data, 0)) {
      if (entry.startsWith("...")) continue;
      const key = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(entry)?.[1];
      if (key) keys.add(key);
    }
  }
  return [...keys].sort();
}

const ROWS = TABLES.flatMap((t) => t.rows.map((row) => ({ table: t.id, row })));
const routeOf = (row: RefRow) => (row.cells.route ?? "").replace(/`/g, "").trim();
const rowFor = (key: string) => ROWS.find((r) => routeOf(r.row) === key)?.row;
/** The "status code" pairs a cell names in backticks. */
const pairsIn = (cell: string) =>
  new Set([...cell.matchAll(/`(\d{3}) ([a-z_]+)`/g)].map((m) => `${m[1]} ${m[2]}`));
/** The names a cell writes in backticks. */
const namesIn = (cell: string) =>
  new Set(
    [...cell.matchAll(/`([^`]+)`/g)].flatMap((m) =>
      [...(m[1] ?? "").matchAll(/[A-Za-z_$][\w$]*/g)].map((w) => w[0]),
    ),
  );
const sorted = (s: Iterable<string>) => [...s].sort();

/** The table of each group of routes, by the path's first segment after /api, or "proof" for a proof file. */
const GROUPS: Record<string, string> = {
  auth: "http-api-auth",
  console: "http-api-console",
  ext: "http-api-extension",
  topup: "http-api-topup",
  canary: "http-api-canary",
  health: "http-api-health",
  cron: "http-api-cron",
  telegram: "http-api-telegram",
  alerts: "http-api-alerts",
  proof: "http-api-proof",
};

describe("the HTTP API reference", () => {
  it("documents every method of every route under src/app/api and of the proof files, and nothing else", () => {
    expect(ROUTES.length, "no route files found").toBeGreaterThan(0);
    expect(
      sorted(ROUTES.filter((r) => r.url.startsWith("/proof/")).map((r) => r.key)),
      "the proof files",
    ).toEqual([
      "GET /proof/:vault/ledger.jsonl",
      "GET /proof/:vault/payments.csv",
      "GET /proof/:vault/snapshot.json",
    ]);
    const code = new Set(ROUTES.map((r) => r.key));
    const docs = new Set(ROWS.map((r) => routeOf(r.row)));
    expect(
      sorted([...code].filter((k) => !docs.has(k))),
      "routes with no row in ref/http-api.ts",
    ).toEqual([]);
    expect(
      sorted([...docs].filter((k) => !code.has(k))),
      "rows for a route the code does not have",
    ).toEqual([]);
    expect(docs.size, "a route documented twice").toBe(ROWS.length);
  });

  it("reads the methods, paths and answers a new route could use", () => {
    expect(methodsOf("export async function PATCH(req) {}")).toEqual(["PATCH"]);
    expect(methodsOf("export const GET = handler;\nexport { h as DELETE, x };")).toEqual([
      "DELETE",
      "GET",
    ]);
    expect(methodsOf("export async function OPTIONS() {}\nexport const HEAD = GET;")).toEqual([
      "HEAD",
      "OPTIONS",
    ]);
    expect(methodsOf("export const dynamic = 'force-dynamic';\nasync function GET() {}")).toEqual(
      [],
    );
    expect(urlOf(join("console", "[vault]", "invoices"))).toBe("/api/console/:vault/invoices");
    expect(urlOf(join("(internal)", "files", "[...path]"))).toBe("/api/files/:path*");
    expect(rowIdOf("POST", "/api/console/:vault/invoices")).toBe(
      "http-api-post-console-vault-invoices",
    );
    expect(urlOf(join("[vault]", "payments.csv"), "/proof")).toBe("/proof/:vault/payments.csv");
    expect(rowIdOf("GET", "/proof/:vault/payments.csv")).toBe(
      "http-api-get-proof-vault-payments-csv",
    );
    expect(groupOf("/proof/:vault/payments.csv")).toBe("proof");
    expect(groupOf("/api/console/:vault/invoices")).toBe("console");
    expect(
      successKeys(
        'return json({ ok: true, ...base, n: f(a, b) });\nreturn json({ error: "x" }, 400);\nreturn json({ a }, 503);\nreturn json({ m }, ok ? 200 : 503);',
      ),
    ).toEqual(["m", "n", "ok"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is route source text, a template literal.
    expect(scopeOf("`a:${network}:${clientIp(req.headers)}`", API)).toBe(
      "per IP address and network",
    );
    expect(scopeOf('"a:global"', API)).toBe("in all");
  });

  it("follows arrow functions, default and namespace imports and re-exports, and names a call it cannot follow", () => {
    const dir = join(WEB, "src", "lib", "__http_api_scan__");
    const put = (name: string, lines: string[]) => texts.set(join(dir, name), lines.join("\n"));
    put("arrow.ts", [
      'import { problem } from "@/lib/http";',
      "export const refuse = (why: string): Response =>",
      '  problem(409, "arrow_code", why);',
      "export const other = 1;",
    ]);
    put("fn.ts", [
      "// A default export, and an error that is not the object's first key.",
      "export default function guard() {",
      '  // problem(400, "in_a_comment") is a comment, not an answer.',
      '  return json({ detail: "Don\'t { retry", error: "json_code" }, 418);',
      "}",
    ]);
    put("ns.ts", ['export function viaNs() { return problem(410, "ns_code"); }']);
    put("again.ts", ['export { refuse as again } from "./arrow";', 'export * from "./ns";']);
    put("lost.ts", [
      "export const lost = make();",
      'function other() { return problem(400, "never_reached"); }',
    ]);
    put("route.ts", [
      'import guard from "../__http_api_scan__/fn";',
      'import * as ns from "./ns";',
      'import { again, viaNs as aliased } from "./again";',
      'import { lost } from "./lost";',
      "export async function OPTIONS() {",
      '  guard(); ns.viaNs(); again("x"); aliased(); lost();',
      "}",
    ]);
    const scan = scanRoute(join(dir, "route.ts"));
    expect(sorted(scan.pairs)).toEqual(["409 arrow_code", "410 ns_code", "418 json_code"]);
    expect(sorted(scan.missing)).toEqual([
      "src/lib/__http_api_scan__/route.ts: lost from src/lib/__http_api_scan__/lost.ts",
    ]);
  });

  it("anchors each row by its area, method and path, in the table of its group", () => {
    const ids = ROWS.map((r) => r.row.id ?? "");
    expect(new Set(ids).size, "a row id used twice").toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(ROW_ID);
    for (const r of ROUTES) {
      const id = rowIdOf(r.method, r.url);
      expect(rowFor(r.key)?.id, r.key).toBe(id);
      const group = groupOf(r.url);
      const table = GROUPS[group];
      expect(table, `no table for the ${group} routes`).toBeDefined();
      expect(ROWS.find((x) => x.row.id === id)?.table, r.key).toBe(table);
    }
    expect(sorted(TABLES.map((t) => t.id)), "a table with no routes").toEqual(
      sorted(new Set(ROUTES.map((r) => GROUPS[groupOf(r.url)] ?? ""))),
    );
  });

  it("says who may call each route, as the route checks it", () => {
    const roleType = /export type MemberRole = ([^;]+);/.exec(src("src/lib/db/tenants.ts"))?.[1];
    const allRoles = [...(roleType ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1] ?? "");
    expect(allRoles.length, "MemberRole in lib/db/tenants.ts").toBeGreaterThan(0);
    for (const r of ROUTES) {
      const who = rowFor(r.key)?.cells.who ?? "";
      const kind = /\bmemberForApi\(/.test(r.text)
        ? "Signed-in session"
        : /\bextAuth\(/.test(r.text)
          ? "Extension token"
          : /\bcronAuthorized\(/.test(r.text)
            ? "`CRON_SECRET`"
            : /\btelegramWebhookSecret\(/.test(r.text)
              ? "Telegram secret"
              : "Public";
      expect(who.startsWith(kind), `${r.key}: "${who}" should start with ${kind}`).toBe(true);
      expect(who.includes("same address"), `${r.key}: same-origin check`).toBe(
        /\bassertSameOrigin\(/.test(r.text),
      );
      const roles = /\bmemberForApi\([^,]+,\s*\[([^\]]*)\]/.exec(r.text)?.[1];
      if (roles === undefined) continue;
      const allowed = [...roles.matchAll(/"(\w+)"/g)].map((m) => m[1] ?? "");
      for (const role of allRoles) {
        expect(new RegExp(`\\b${role}\\b`).test(who), `${r.key}: role ${role}`).toBe(
          allowed.includes(role),
        );
      }
    }
  });

  it("lists every error code each route can answer, each a row on the errors page", () => {
    const known = new Set(HTTP_ERRORS.map((e) => `${e.status} ${e.code}`));
    for (const r of ROUTES) {
      const cell = rowFor(r.key)?.cells.errors ?? "";
      const docs = pairsIn(cell);
      const code = expected(r).pairs;
      expect(
        sorted([...code].filter((p) => !docs.has(p))),
        `${r.key}: answers the code has and the row lacks`,
      ).toEqual([]);
      expect(
        sorted([...docs].filter((p) => !code.has(p))),
        `${r.key}: answers the row names and the code does not give`,
      ).toEqual([]);
      for (const p of docs) expect(known.has(p), `${r.key}: ${p} is not in HTTP_ERRORS`).toBe(true);
      if (docs.size === 0) expect(cell, r.key).toMatch(/^None\b/);
    }
    for (const [key, remap] of Object.entries(REMAPPED)) {
      const route = ROUTES.find((r) => r.key === key);
      expect(route?.text, `${key} still remaps its guard's answers`).toMatch(remap.shows);
    }
  });

  it("reads every answer, apart from the two whose code is a variable", () => {
    const dynamic = new Set(ROUTES.flatMap((r) => [...expected(r).dynamic]));
    expect(sorted(dynamic), "an answer the scan cannot read").toEqual([
      `src/app/api/auth/verify/route.ts: ${SIGN_IN_FAILURE}`,
      `src/app/api/canary/attempt/route.ts: ${CANARY_REJECTION}`,
    ]);
    const missing = new Set(ROUTES.flatMap((r) => [...expected(r).missing]));
    expect(
      sorted(missing),
      "a call into a module that answers, which the scan cannot follow",
    ).toEqual([]);
  });

  it("names the rate limits each route takes, with the numbers in LIMITS", () => {
    for (const r of ROUTES) {
      const cell = rowFor(r.key)?.cells.limit ?? "";
      const named = new Set(
        [...cell.matchAll(/`(\w+)`/g)]
          .map((m) => m[1] ?? "")
          .filter((k) => Object.hasOwn(LIMITS, k)),
      );
      const code = expected(r).limits;
      expect(sorted(named), `${r.key}: the LIMITS keys`).toEqual(sorted(code));
      if (code.size === 0) expect(cell, r.key).toMatch(/^None\b/);
      for (const key of named) {
        const [max] = LIMITS[key as keyof typeof LIMITS];
        expect(cell, `${r.key}: ${key}`).toMatch(new RegExp(`\\b${max} [^;(]*\\(\`${key}\`\\)`));
      }
    }
  });

  it("says what each rate limit counts, as its bucket key is made", () => {
    for (const r of ROUTES) {
      const cell = rowFor(r.key)?.cells.limit ?? "";
      const { limits, scopes } = expected(r);
      for (const key of limits) {
        const said = scopes.get(key) ?? new Set<string>();
        expect(said.size, `${r.key}: one bucket kind for ${key}`).toBe(1);
        const [scope] = said;
        const cellSays = new RegExp(`(per [^;(]*?|in all) \\(\`${key}\`\\)`).exec(cell)?.[1];
        expect(cellSays, `${r.key}: what ${key} counts`).toBe(scope);
      }
    }
  });

  it("names every field of each success answer the route writes out", () => {
    for (const r of ROUTES) {
      const named = namesIn(rowFor(r.key)?.cells.success ?? "");
      for (const key of successKeys(r.text)) {
        expect(named.has(key), `${r.key}: the success field ${key}`).toBe(true);
      }
    }
  });

  it("writes every cell as plain Rich text", () => {
    for (const { row } of ROWS) {
      for (const [key, cell] of Object.entries(row.cells)) {
        const prose = cell.replace(/`[^`]+`/g, "");
        expect(prose, `${row.id} ${key}`).not.toMatch(/[{}<>]|\]\(|!/);
        expect(cell, `${row.id} ${key}: an em dash`).not.toContain(String.fromCharCode(0x2014));
        expect((cell.match(/`/g) ?? []).length % 2, `${row.id} ${key}: a backtick`).toBe(0);
        expect(cell.trim(), `${row.id} ${key}: an empty cell`).not.toBe("");
      }
    }
  });

  it("shows every table on the page, and links only error rows that exist", () => {
    const page = readMdx("build/http-api");
    const shown = [...page.matchAll(/<RefTable id="([^"]+)" \/>/g)].map((m) => m[1] ?? "");
    expect(sorted(shown)).toEqual(sorted(TABLES.map((t) => t.id)));
    const known = new Set(HTTP_ERRORS.map((e) => `http-${e.status}-${e.code}`));
    for (const m of page.matchAll(/\/docs\/build\/errors#(http-\d{3}-[a-z_]+)/g)) {
      expect(known.has(m[1] ?? ""), m[0]).toBe(true);
    }
    const rows = new Set(ROWS.map((r) => r.row.id));
    for (const m of page.matchAll(/\/docs\/build\/http-api#([a-z0-9_-]+)/g)) {
      expect(rows.has(m[1] ?? ""), m[0]).toBe(true);
    }
  });
});

// The settings the page and its cells state as numbers (lifetimes, caps, lengths, the faucet's mint, the schedules) are
// read from the code here: imported where the module loads in node, else parsed from its source. A change on either
// side fails the test, so the page is re-read. The count of callers and the success status codes are not pinned here.

/** 4259840 -> "4,259,840", as the cells write a byte count. */
const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The value of `const <name> = <digits>;` in a file under apps/web. */
function constIn(path: string, name: string): number {
  const m = new RegExp(`\\bconst ${name} = ([\\d_]+);`).exec(src(path));
  expect(m, `${name} in ${path}`).not.toBeNull();
  return Number((m?.[1] ?? "").replace(/_/g, ""));
}

/** The last migration's definition of a SQL function, from its `create` to the end of its body. */
function sqlFunction(name: string): string {
  const dir = join(WEB, "supabase", "migrations");
  const head = new RegExp(`create or replace function public\\.${name}\\b`);
  const last =
    readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => read(join(dir, f)))
      .filter((t) => head.test(t))
      .at(-1) ?? "";
  const from = last.search(head);
  expect(from, `a migration that defines ${name}`).toBeGreaterThanOrEqual(0);
  const body = last.slice(from);
  const end = body.indexOf("$$;", body.indexOf("$$") + 2);
  return end === -1 ? body : body.slice(0, end);
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];

describe("the numbers on the HTTP API page", () => {
  const page = readMdx("build/http-api");
  const cell = (key: string, column: string) => rowFor(key)?.cells[column] ?? "";

  it("marks the page Preview on testnet, and says the 1Click routes are built for mainnet only", () => {
    const entry = findPage("build/http-api");
    expect(entry?.status).toBe("preview");
    expect(entry?.network).toBe("testnet");
    expect(src("src/lib/topup/gate.ts")).toMatch(
      /if \(network !== "mainnet"\) return problem\(409, "mainnet_only"/,
    );
    expect(page).toContain(
      "The 1Click top-up routes are built for mainnet only and answer `409 mainnet_only` elsewhere.",
    );
  });

  it("states the cookie lifetimes sign-in sets", () => {
    expect(src("src/app/api/auth/challenge/route.ts")).toMatch(/cookieOptions\(CHALLENGE_TTL_MS\)/);
    expect(src("src/app/api/auth/verify/route.ts")).toMatch(/cookieOptions\(SESSION_TTL_MS\)/);
    const minutes = CHALLENGE_TTL_MS / 60_000;
    const hours = SESSION_TTL_MS / 3_600_000;
    expect(cell("GET /api/auth/challenge", "success")).toContain(
      `the \`pb_chal\` cookie for ${minutes} minutes`,
    );
    expect(cell("POST /api/auth/verify", "success")).toContain(
      `the \`pb_session\` cookie for ${hours} hours`,
    );
    expect(page).toContain(`a stateless signed cookie that lasts ${hours} hours`);
  });

  it("states the body caps the routes check", () => {
    const verify = constIn("src/app/api/auth/verify/route.ts", "MAX_BODY_BYTES");
    expect(cell("POST /api/auth/verify", "body")).toContain(`${verify} bytes at most`);
    const pair = constIn("src/app/api/ext/pair/route.ts", "MAX_BODY_BYTES");
    expect(cell("POST /api/ext/pair", "body")).toContain(`${pair / 1024} KiB at most`);
    // The console route checks lib/payables/upload.ts's MAX_REQUEST_BYTES, and the extension route its own sum.
    const consoleRoute = src("src/app/api/console/[vault]/invoices/route.ts");
    expect(consoleRoute, "the invoices route reads upload.ts's cap").toMatch(
      /import \{[^}]*\bMAX_REQUEST_BYTES\b[^}]*\} from "@\/lib\/payables\/upload";/,
    );
    expect(consoleRoute).toMatch(/\bNumber\(length\) > MAX_REQUEST_BYTES\b/);
    const form = /\bexport const MAX_REQUEST_BYTES = MAX_INVOICE_BYTES \+ (\d+) \* 1024;/.exec(
      src("src/lib/payables/upload.ts"),
    )?.[1];
    expect(form, "MAX_REQUEST_BYTES in lib/payables/upload.ts").toBeDefined();
    expect(cell("POST /api/console/:vault/invoices", "body")).toContain(
      `${grouped(MAX_INVOICE_BYTES + Number(form) * 1024)} bytes at most in all, and ${grouped(MAX_INVOICE_BYTES)} bytes at most for each file`,
    );
    const extRoute = src("src/app/api/ext/invoices/route.ts");
    expect(extRoute).toMatch(/\bNumber\(length\) > MAX_EXT_REQUEST_BYTES\b/);
    const extForm = /\bconst MAX_EXT_REQUEST_BYTES = MAX_INVOICE_BYTES \+ (\d+) \* 1024;/.exec(
      extRoute,
    )?.[1];
    expect(extForm, "MAX_EXT_REQUEST_BYTES in the extension's invoices route").toBeDefined();
    expect(cell("POST /api/ext/invoices", "body")).toContain(
      `${grouped(MAX_INVOICE_BYTES + Number(extForm) * 1024)} bytes at most in all, and ${grouped(MAX_INVOICE_BYTES)} bytes at most for the file`,
    );
  });

  it("states the shortest CRON_SECRET the scheduled jobs take", () => {
    const min = constIn("src/lib/cron.ts", "MIN_SECRET_LENGTH");
    expect(page).toContain(`A secret shorter than ${min} characters refuses every call.`);
    const call = (secret: string) =>
      cronAuthorized(
        new Request("https://probarion.test/api/cron/watch", {
          headers: { authorization: `Bearer ${secret}` },
        }),
        secret,
      );
    expect(call("s".repeat(min - 1)), "a secret one character short").toBe(false);
    expect(call("s".repeat(min)), "a secret just long enough").toBe(true);
  });

  it("states the prefix an IPv6 address counts by", () => {
    const key = clientIp(new Headers({ "x-forwarded-for": "2001:db8:1:2:3:4:5:6" }));
    expect(clientIp(new Headers({ "x-forwarded-for": "2001:db8:1:2:ffff:4:5:7" }))).toBe(key);
    expect(
      clientIp(new Headers({ "x-forwarded-for": "2001:db8:1:3:3:4:5:6" })),
      "the 4th group",
    ).not.toBe(key);
    const prefix = /\/(\d+)$/.exec(key)?.[1];
    expect(prefix, key).toBeDefined();
    expect(page).toContain(`An IPv6 address counts by its /${prefix}.`);
  });

  it("states the extension token's shape, the pairing code's and the code's lifetime", () => {
    const { token, hint } = newToken();
    expect(TOKEN_RE.test(token), token).toBe(true);
    const rest = /^\^pbx_\[[^\]]+\]\{(\d+)\}\$$/.exec(TOKEN_RE.source)?.[1];
    expect(rest, TOKEN_RE.source).toBe(String(token.length - "pbx_".length));
    expect(page).toContain(`A token is \`pbx_\` and ${rest} more characters.`);
    expect(token.endsWith(hint)).toBe(true);
    const last = `its last ${NUMBER_WORDS[hint.length]} characters`;
    expect(page).toContain(last);
    expect(cell("POST /api/ext/pair", "success")).toContain(last);
    const code = newPairCode();
    const shown = showCode(code).replace(/[0-9A-Z]/g, "X");
    expect(page).toContain(`A code is ${code.length} letters and digits, shown as \`${shown}\``);
    const minutes = /v_exp timestamptz := now\(\) \+ interval '(\d+) minutes'/.exec(
      sqlFunction("ext_code_create"),
    )?.[1];
    expect(minutes, "the code's lifetime in ext_code_create").toBeDefined();
    expect(page).toContain(`is good once, for ${minutes} minutes`);
  });

  it("states what the faucet mints and how often", () => {
    const faucet = src("src/lib/topup/faucet.ts");
    const usdc = /^export const FAUCET_USDC = "(\d+)";/m.exec(faucet)?.[1];
    expect(usdc, "FAUCET_USDC in lib/topup/faucet.ts").toBeDefined();
    expect(faucet).toMatch(/json\(\{ status: "minted", [^}]*amount: FAUCET_USDC \}\)/);
    expect(page).toContain(`\`POST /api/topup/faucet\` mints ${usdc} test USDC into the vault`);
    expect(cell("POST /api/topup/faucet", "success")).toContain(`amount: "${usdc}"`);
    expect(LIMITS.faucetVault, "one mint per vault a day").toEqual([1, 86_400]);
    expect(page).toContain("It works once a UTC day per vault");
  });

  it("states the health probes' timeout and cache", () => {
    expect(src("src/lib/health-server.ts"), "a probe given its own timeout or cache").not.toMatch(
      /\b(?:timeoutMs|ttlMs)\b/,
    );
    expect(page).toContain(`make one call each, of ${HEALTH_TIMEOUT_MS / 1000} seconds at most`);
    for (const key of ["GET /api/health/rpc", "GET /api/health/nearai"]) {
      expect(cell(key, "limit"), key).toContain(
        `kept ${HEALTH_CACHE_MS / 1000} seconds per server instance`,
      );
    }
  });

  it("states when vercel.json runs the scheduled jobs", () => {
    const crons =
      (JSON.parse(src("vercel.json")) as { crons?: { path: string; schedule: string }[] }).crons ??
      [];
    expect(sorted(crons.map((c) => c.path))).toEqual(["/api/cron/metrics", "/api/cron/watch"]);
    for (const c of crons) {
      const m = /^(\d+) (\d+) \* \* \*$/.exec(c.schedule);
      expect(m, `${c.path}: a daily schedule`).not.toBeNull();
      const at = `${(m?.[2] ?? "").padStart(2, "0")}:${(m?.[1] ?? "").padStart(2, "0")} UTC`;
      expect(page).toContain(`\`${c.path}\` at ${at}`);
    }
    expect(page).toMatch(/`\/api\/cron\/metrics` at \d\d:\d\d UTC each day\./);
  });

  it("states the alert confirmation code's shape and lifetime", () => {
    const hex = Number(
      /`code`, (\d+) hex characters/.exec(cell("POST /api/alerts/confirm", "body"))?.[1],
    );
    expect(isLinkCode("a".repeat(hex)), `${hex} hex characters`).toBe(true);
    expect(isLinkCode("a".repeat(hex - 1)), "one short").toBe(false);
    expect(isLinkCode("a".repeat(hex + 1)), "one too many").toBe(false);
    expect(isLinkCode("g".repeat(hex)), "not hex").toBe(false);
    const hours = /a\.link_code = v_code[^;]*interval '(\d+) hours'/.exec(
      sqlFunction("alert_subscription_verify"),
    )?.[1];
    expect(hours, "the code's lifetime in alert_subscription_verify").toBeDefined();
    expect(page).toContain(`The code is good once, for ${hours} hours.`);
  });

  it("states each proof file's type, name and caching as its module writes them", () => {
    const files = [
      {
        route: "GET /proof/:vault/snapshot.json",
        lib: "src/lib/proof/snapshot-file.ts",
        name: snapshotFileName("<vault>"),
      },
      {
        route: "GET /proof/:vault/ledger.jsonl",
        lib: "src/lib/proof/ledger-file.ts",
        name: ledgerFileName("<vault>"),
      },
      {
        route: "GET /proof/:vault/payments.csv",
        lib: "src/lib/proof/payments-csv.ts",
        name: paymentsCsvFileName("<vault>", "2026-11-09T11:58:06Z").replace(
          "20261109T115806Z",
          "<capture time>",
        ),
      },
    ];
    const tick = "`";
    for (const f of files) {
      const type = /"content-type": "([^"]+)"/.exec(src(f.lib))?.[1];
      expect(type, `${f.lib}: its content-type`).toBeDefined();
      expect(cell(f.route, "success"), f.route).toContain(`${tick}${type}${tick}`);
      expect(cell(f.route, "success"), f.route).toContain(`saved as ${tick}${f.name}${tick}`);
      expect(src(f.lib), f.lib).toContain(
        '"private, max-age=0, must-revalidate" : "private, no-store"',
      );
    }
    expect(page).toContain(
      "a public vault's answer is sent with `cache-control: private, max-age=0, must-revalidate`, a member's with `private, no-store`",
    );
    // The payments file is what the cell says: a BOM, then RFC 4180 records ended by CRLF.
    const empty = paymentsCsv([], "2026-11-09T11:58:06Z");
    expect(empty.startsWith(`${String.fromCharCode(0xfeff)}Date (UTC),`)).toBe(true);
    expect(empty.endsWith("\r\n")).toBe(true);
    // The page lists the file's columns as the module writes them, in order.
    const columns = [...PAYMENTS_COLUMNS];
    const last = columns.pop();
    expect(page).toContain(`Its columns are ${columns.join(", ")} and ${last}.`);
    expect(empty).toBe(`${String.fromCharCode(0xfeff)}${PAYMENTS_COLUMNS.join(",")}\r\n`);
  });

  it("names each proof file on the Errors row of the 404 the three answer", () => {
    const row = HTTP_ERRORS.find((e) => e.status === 404 && e.code === "not_found");
    expect(row?.where).toContain("Proof files (snapshot.json, ledger.jsonl, payments.csv)");
    const files = readdirSync(join(PROOF, "[vault]"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(files).toContain("payments.csv");
    for (const name of files) expect(row?.where, name).toContain(name);
  });
});
