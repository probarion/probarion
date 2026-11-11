import { readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { TABLES } from "@/lib/docs/ref/contract";
import type { RefRow, RefTable } from "@/lib/docs/ref/types";
import { ROOT, readMdx, walkFiles } from "./docs-helpers";

// The contract reference pinned to the Rust source. The reader below finds every `pub fn` of every
// `#[near]` impl block (and every `fn` of a `#[near]` trait impl), outside `#[cfg(test)]` items,
// straight from the text. It follows each method through the helpers it calls (`self.x(`,
// `Self::x(` and free functions), so the codes it raises, in order, the events it logs and the
// callbacks it schedules come from the code. It never reads the tables, so a method added, removed
// or changed in the code fails here until its row follows.

// --- a small Rust reader -------------------------------------------------------------------------

interface Source {
  readonly file: string;
  readonly text: string;
}

/** Blanks [from, to) with spaces, keeping newlines, so offsets stay valid. */
function blank(chars: string[], from: number, to: number): void {
  for (let k = from; k < to; k++) if (chars[k] !== "\n") chars[k] = " ";
}

/**
 * The source with its comments blanked (`text`), and with its string and char literals blanked as
 * well (`code`). Both keep every offset, so a range found in `code` can be read in `text`.
 */
function blankRust(src: string): { text: string; code: string } {
  const text = src.split("");
  const code = src.split("");
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i, i + 64);
    if (rest.startsWith("//")) {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      blank(text, i, end);
      blank(code, i, end);
      i = end;
      continue;
    }
    if (rest.startsWith("/*")) {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (src.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else j++;
      }
      blank(text, i, j);
      blank(code, i, j);
      i = j;
      continue;
    }
    const raw = /^b?r(#*)"/.exec(rest);
    if (raw && !/\w/.test(src.charAt(i - 1))) {
      const close = `"${raw[1] ?? ""}`;
      const at = src.indexOf(close, i + raw[0].length);
      const end = at < 0 ? src.length : at + close.length;
      blank(code, i, end);
      i = end;
      continue;
    }
    if (src.charAt(i) === '"') {
      let j = i + 1;
      while (j < src.length && src.charAt(j) !== '"') j += src.charAt(j) === "\\" ? 2 : 1;
      blank(code, i, j + 1);
      i = j + 1;
      continue;
    }
    if (src.charAt(i) === "'") {
      // A char literal such as '{' or b'_'. A lifetime ('a, 'static) has no closing quote.
      const ch = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.)|[^\\'\n])'/.exec(rest);
      if (ch) {
        blank(code, i, i + ch[0].length);
        i += ch[0].length;
        continue;
      }
    }
    i++;
  }
  return { text: text.join(""), code: code.join("") };
}

const PAIRS: Readonly<Record<string, string>> = { "{": "}", "(": ")", "[": "]", "<": ">" };

/** The offset of the bracket that closes the one at `open`, in blanked code. */
function closing(code: string, open: number): number {
  const o = code.charAt(open);
  const c = PAIRS[o];
  if (!c) throw new Error(`no bracket at offset ${open}`);
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    const ch = code.charAt(k);
    if (ch === o) depth++;
    else if (ch === c && !(o === "<" && /[-=]/.test(code.charAt(k - 1)))) {
      depth--;
      if (depth === 0) return k;
    }
  }
  throw new Error(`no closing ${c} for the ${o} at offset ${open}`);
}

/** Where a regex match starts. */
const startOf = (m: RegExpMatchArray) => m.index ?? 0;

/** `code` with every `#[cfg(test)]` item blanked: an inline test module, or any other item with a body. */
function withoutTests(code: string): string {
  const out = code.split("");
  for (const m of code.matchAll(/#\[\s*cfg\s*\(\s*test\s*\)\s*\]/g)) {
    const after = startOf(m) + m[0].length;
    const brace = code.indexOf("{", after);
    const semi = code.indexOf(";", after);
    const end = brace >= 0 && (semi < 0 || brace < semi) ? closing(code, brace) + 1 : semi + 1;
    blank(out, startOf(m), end);
  }
  return out.join("");
}

/** The offset of the `[` that opens the attribute ending in the `]` at `close`, or -1. */
function attrOpen(code: string, close: number): number {
  let depth = 0;
  for (let j = close; j >= 0; j--) {
    if (code.charAt(j) === "]") depth++;
    if (code.charAt(j) === "[") depth--;
    if (depth === 0) return j;
  }
  return -1;
}

/** The outer attributes written right before offset `at`, in source order. */
function attrsBefore(code: string, at: number): string[] {
  const out: string[] = [];
  let k = at - 1;
  while (k >= 0) {
    while (k >= 0 && /\s/.test(code.charAt(k))) k--;
    if (code.charAt(k) !== "]") break;
    const j = attrOpen(code, k);
    if (j < 1 || code.charAt(j - 1) !== "#") break;
    out.unshift(code.slice(j - 1, k + 1));
    k = j - 2;
  }
  return out;
}

/** `#[payable]` → payable, `#[init(ignore_state)]` → init, `#[near_sdk::near]` → near. */
function attrName(attr: string): string {
  return /^#\[\s*(?:[\w:]+::)?(\w+)/.exec(attr)?.[1] ?? "";
}

const isNearImplAttr = (attr: string) =>
  /^#\[\s*(?:near_sdk\s*::\s*)?(?:near|near_bindgen)\s*\]$/.test(attr);

/** `code` between `from` and `to` with everything inside nested braces blanked (braces kept). */
function topLevel(code: string, from: number, to: number): string {
  let depth = 0;
  let s = "";
  for (let k = from; k < to; k++) {
    const ch = code.charAt(k);
    if (ch === "{") {
      s += depth === 0 ? ch : " ";
      depth++;
    } else if (ch === "}") {
      depth--;
      s += depth === 0 ? ch : " ";
    } else s += depth === 0 || ch === "\n" ? ch : " ";
  }
  return s;
}

/** Splits at the commas that are not inside `<>`, `()` or `[]`. */
function splitTop(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if ("<([".includes(ch)) depth++;
    else if (">)]".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p !== "");
}

const squash = (type: string) => type.replace(/\s+/g, "");

type Receiver = "ref" | "mut" | "value" | "none";

interface Param {
  readonly name: string;
  readonly type: string;
}

/** A function body, from its `{` to its `}`: comments blanked (`text`), and strings too (`code`). */
interface Body {
  readonly text: string;
  readonly code: string;
}

interface RustMethod {
  readonly name: string;
  readonly file: string;
  readonly attrs: readonly string[];
  readonly receiver: Receiver;
  readonly params: readonly Param[];
  /** The return type with whitespace removed, or null when there is none. */
  readonly returns: string | null;
  readonly body: Body;
}

interface Contract {
  readonly methods: readonly RustMethod[];
  /** `EnumName` → its events' snake_case names, for each `#[near(event_json(...))]` enum. */
  readonly events: ReadonlyMap<string, ReadonlySet<string>>;
  /** The variants of `enum ErrorCode`, when one of the files defines it. */
  readonly errorCodes: ReadonlySet<string>;
  /** Every free function with a body, by name (`fail`, `require_one_yocto`, `is_hex64`). */
  readonly free: ReadonlyMap<string, readonly Body[]>;
  /** Every function with a body inside an impl block, by name, exported or not. */
  readonly impl: ReadonlyMap<string, readonly Body[]>;
  /** The `#[private]` methods: the callbacks. */
  readonly privates: ReadonlySet<string>;
}

const snake = (variant: string) => variant.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** The variant names of the enum whose `{` is at `open`. */
function variants(code: string, open: number): string[] {
  const top = topLevel(code, open + 1, closing(code, open)).replace(/#\[[^\]]*\]/g, " ");
  return [...top.matchAll(/(?<![\w])([A-Z][A-Za-z0-9]*)\s*(?=[{(,]|$)/g)].map((m) => m[1] ?? "");
}

/** A body's slice of both forms of the file, from the `{` at `open` to its `}`. */
function bodyAt(text: string, code: string, open: number): Body {
  const end = closing(code, open) + 1;
  return { text: text.slice(open, end), code: code.slice(open, end) };
}

function methodsOf(src: Source, text: string, code: string): RustMethod[] {
  const out: RustMethod[] = [];
  for (const m of code.matchAll(/(?<![\w])impl\b/g)) {
    if (!attrsBefore(code, startOf(m)).some(isNearImplAttr)) continue;
    const open = code.indexOf("{", startOf(m));
    const header = code.slice(startOf(m), open);
    const isTrait = /\bfor\b/.test(header);
    const end = closing(code, open);
    const top = topLevel(code, open + 1, end);
    const FN =
      /(?<![\w])(pub(?:\s*\([^)]*\))?\s+)?(?:(?:const|async|unsafe)\s+)*fn\s+([A-Za-z_]\w*)/g;
    for (const f of top.matchAll(FN)) {
      const visibility = squash(f[1] ?? "");
      // A trait impl's methods are public through the trait; anywhere else only `pub fn` is.
      if (!isTrait && visibility !== "pub") continue;
      const name = f[2] ?? "";
      const start = open + 1 + startOf(f);
      let k = start + f[0].length;
      while (/\s/.test(code.charAt(k))) k++;
      if (code.charAt(k) === "<") k = closing(code, k) + 1;
      while (/\s/.test(code.charAt(k))) k++;
      if (code.charAt(k) !== "(") throw new Error(`${src.file}: fn ${name} has no parameter list`);
      const close = closing(code, k);
      const bodyOpen = code.indexOf("{", close);
      const tail = code.slice(close + 1, bodyOpen).replace(/\bwhere\b[\s\S]*$/, "");
      const returns = /->\s*([\s\S]+)$/.exec(tail)?.[1];
      const parts = splitTop(code.slice(k + 1, close).replace(/#\[[^\]]*\]/g, " "));
      const first = parts[0] ?? "";
      const hasSelf = /^(?:&\s*(?:'\w+\s+)?)?(?:mut\s+)?self$/.test(first);
      const receiver: Receiver = !hasSelf
        ? "none"
        : first.startsWith("&")
          ? /\bmut\b/.test(first)
            ? "mut"
            : "ref"
          : "value";
      const params = (hasSelf ? parts.slice(1) : parts).map((p) => {
        const pm = /^(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/.exec(p);
        if (!pm) throw new Error(`${src.file}: fn ${name}: cannot read the parameter "${p}"`);
        return { name: pm[1] ?? "", type: squash(pm[2] ?? "") };
      });
      out.push({
        name,
        file: src.file,
        attrs: attrsBefore(code, start).map(attrName),
        receiver,
        params,
        returns: returns === undefined ? null : squash(returns),
        body: bodyAt(text, code, bodyOpen),
      });
    }
  }
  return out;
}

/**
 * Every `fn` with a body in the file, exported or not, and whether it is free (at the file's top
 * level) or inside an impl block. A trait's bodiless declarations (`fn x(...);`) are skipped.
 */
function functionsOf(text: string, code: string): { name: string; free: boolean; body: Body }[] {
  const depth: number[] = [];
  let d = 0;
  for (let k = 0; k < code.length; k++) {
    depth.push(d);
    if (code.charAt(k) === "{") d++;
    else if (code.charAt(k) === "}") d--;
  }
  const out: { name: string; free: boolean; body: Body }[] = [];
  for (const f of code.matchAll(/(?<![\w])fn\s+([A-Za-z_]\w*)/g)) {
    let k = startOf(f) + f[0].length;
    while (/\s/.test(code.charAt(k))) k++;
    if (code.charAt(k) === "<") k = closing(code, k) + 1;
    while (/\s/.test(code.charAt(k))) k++;
    if (code.charAt(k) !== "(") continue;
    // After the parameters: the return type (skipping `[u8; 32]` and `(A, B)`), then `{` or `;`.
    k = closing(code, k) + 1;
    while (k < code.length && code.charAt(k) !== "{" && code.charAt(k) !== ";") {
      k = code.charAt(k) === "[" || code.charAt(k) === "(" ? closing(code, k) + 1 : k + 1;
    }
    if (code.charAt(k) !== "{") continue;
    out.push({ name: f[1] ?? "", free: depth[startOf(f)] === 0, body: bodyAt(text, code, k) });
  }
  return out;
}

/** Reads one contract from its source files. */
function readContract(sources: readonly Source[]): Contract {
  const methods: RustMethod[] = [];
  const events = new Map<string, Set<string>>();
  const errorCodes = new Set<string>();
  const free = new Map<string, Body[]>();
  const impl = new Map<string, Body[]>();
  for (const src of sources) {
    const blanked = blankRust(src.text);
    const code = withoutTests(blanked.code);
    methods.push(...methodsOf(src, blanked.text, code));
    for (const f of functionsOf(blanked.text, code)) {
      const into = f.free ? free : impl;
      into.set(f.name, [...(into.get(f.name) ?? []), f.body]);
    }
    const ENUM = /(?<![\w])(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+(\w+)[^{;]*\{/g;
    for (const m of code.matchAll(ENUM)) {
      const name = m[1] ?? "";
      const open = startOf(m) + m[0].length - 1;
      if (attrsBefore(code, startOf(m)).some((a) => a.includes("event_json"))) {
        events.set(name, new Set(variants(code, open).map(snake)));
      }
      if (name === "ErrorCode") for (const v of variants(code, open)) errorCodes.add(v);
    }
  }
  const privates = new Set(methods.filter((m) => m.attrs.includes("private")).map((m) => m.name));
  return { methods, events, errorCodes, free, impl, privates };
}

/** The kind a row must show for this method. */
function kindOf(m: RustMethod): string {
  if (m.attrs.includes("init")) return "init";
  if (m.attrs.includes("private")) return "private callback";
  if (m.receiver === "ref") return "view";
  if (m.receiver === "mut" || m.receiver === "value") return "call";
  return "a method with no self that is not #[init]";
}

// --- following a method through its helpers -----------------------------------------------------

/** A panic with a fixed code: `fail(ErrorCode::X)` in the vault, `fail("X")` in the factory. */
const RAISE = /\bfail\(\s*(?:ErrorCode::([A-Z]\w*)|"([A-Za-z]+)")\s*\)/g;
/** A panic with a code held in a variable, such as `Err(code) => fail(code)`. */
const FAIL_VAR = /\bfail\(\s*[a-z_]\w*\s*\)/;

type Site =
  /** `raise`: a `fail` with a fixed code. `return`: any other `ErrorCode::X`, such as `Err(ErrorCode::X)`. */
  | { readonly at: number; readonly kind: "raise" | "return"; readonly code: string }
  | { readonly at: number; readonly kind: "call"; readonly fn: string; readonly free: boolean }
  /** A call to a `#[private]` method on a promise: it runs in a later receipt. */
  | { readonly at: number; readonly kind: "callback"; readonly fn: string };

/** What a body does that matters here, in source order. */
function sitesOf(b: Body, c: Contract): Site[] {
  const sites: Site[] = [];
  for (const m of b.text.matchAll(RAISE)) {
    sites.push({ at: startOf(m), kind: "raise", code: m[1] ?? m[2] ?? "" });
  }
  const rest = b.text.replace(RAISE, (s) => " ".repeat(s.length));
  for (const m of rest.matchAll(/\bErrorCode::([A-Z]\w*)/g)) {
    sites.push({ at: startOf(m), kind: "return", code: m[1] ?? "" });
  }
  for (const m of b.code.matchAll(/\b(?:self\s*\.|Self\s*::)\s*([a-z_]\w*)\s*\(/g)) {
    const fn = m[1] ?? "";
    if (c.impl.has(fn)) sites.push({ at: startOf(m), kind: "call", fn, free: false });
  }
  for (const m of b.code.matchAll(/(?<![\w.:])([a-z_]\w*)\s*\(/g)) {
    const fn = m[1] ?? "";
    if (c.free.has(fn)) sites.push({ at: startOf(m), kind: "call", fn, free: true });
  }
  for (const m of b.code.matchAll(/(?<!\bself\s*)\.\s*([a-z_]\w*)\s*\(/g)) {
    const fn = m[1] ?? "";
    if (c.privates.has(fn)) sites.push({ at: startOf(m), kind: "callback", fn });
  }
  return sites.sort((x, y) => x.at - y.at);
}

/** The events a body logs itself, as snake_case names. */
function emittedBy(b: Body, c: Contract): string[] {
  return [...b.code.matchAll(/\b(\w+)::([A-Z]\w*)/g)].flatMap((x) =>
    c.events.has(x[1] ?? "") ? [snake(x[2] ?? "")] : [],
  );
}

const bodiesOf = (c: Contract, s: { readonly fn: string; readonly free: boolean }) =>
  (s.free ? c.free : c.impl).get(s.fn) ?? [];

/** Everything one receipt of `start` reaches through its calls: functions, events, callbacks. */
function closure(start: Body, c: Contract) {
  const reached = new Set<string>();
  const events = new Set<string>();
  const callbacks = new Set<string>();
  const seen = new Set<string>();
  const queue: Body[] = [start];
  for (let b = queue.shift(); b; b = queue.shift()) {
    for (const e of emittedBy(b, c)) events.add(e);
    for (const s of sitesOf(b, c)) {
      if (s.kind === "callback") callbacks.add(s.fn);
      if (s.kind !== "call") continue;
      reached.add(s.fn);
      const key = `${s.free ? "free" : "impl"}:${s.fn}`;
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(...bodiesOf(c, s));
      }
    }
  }
  return { reached, events, callbacks };
}

/**
 * The codes a caller of `start` can meet, each once, in the order the code reaches them. A call to
 * an `exempt` helper is not followed. A body that panics with a code held in a variable surfaces the
 * `ErrorCode::X` values of the helpers it calls (the codes `evaluate` returns, for `spend`).
 */
function codesOf(start: Body, c: Contract, exempt: ReadonlySet<string>): string[] {
  const codes: string[] = [];
  const seen = new Set<string>();
  const walk = (b: Body, surface: boolean): void => {
    const failsVar = FAIL_VAR.test(b.code);
    for (const s of sitesOf(b, c)) {
      if (s.kind === "raise" || (s.kind === "return" && surface)) codes.push(s.code);
      if (s.kind !== "call" || exempt.has(s.fn)) continue;
      const key = `${s.free ? "free" : "impl"}:${s.fn}:${failsVar}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const callee of bodiesOf(c, s)) walk(callee, failsVar);
    }
  };
  walk(start, false);
  return [...new Set(codes)];
}

interface Trace {
  /** The codes a caller can meet, in order, without the exempt helpers' codes. */
  readonly codes: readonly string[];
  /** Every function the method's own receipt calls, exempt helpers included. */
  readonly reached: ReadonlySet<string>;
  /** The events the method's own receipt can log. */
  readonly events: ReadonlySet<string>;
  /** Each callback the method schedules → the events that callback's receipt can log. */
  readonly callbacks: ReadonlyMap<string, ReadonlySet<string>>;
}

function traceOf(
  m: RustMethod,
  c: Contract,
  exemptCallees: ReadonlySet<string> = new Set(),
  exemptEventsOf: (callback: string) => ReadonlySet<string> = () => new Set(),
): Trace {
  const own = closure(m.body, c);
  const callbacks = new Map<string, ReadonlySet<string>>();
  for (const name of own.callbacks) {
    const cb = c.methods.find((x) => x.name === name);
    if (!cb) continue;
    const skip = exemptEventsOf(name);
    callbacks.set(name, new Set([...closure(cb.body, c).events].filter((e) => !skip.has(e))));
  }
  return {
    codes: codesOf(m.body, c, exemptCallees),
    reached: own.reached,
    events: own.events,
    callbacks,
  };
}

// --- the comparison ------------------------------------------------------------------------------

/**
 * What a row may leave out, and why. `codes`: row id → a helper whose codes the row does not name.
 * `events`: row id → an event the code could log on paper but cannot for this method.
 */
interface Exemptions {
  readonly codes: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly events: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const NO_EXEMPTIONS: Exemptions = { codes: {}, events: {} };
const ONE_YOCTO_CELL = "Exactly 1 yoctoNEAR";
/** A guard the code calls → how the "Who may call" cell must start. */
const ROLES: readonly (readonly [string, RegExp, string])[] = [
  ["assert_owner", /^The (?:factory )?owner\b/, "The owner"],
  ["assert_approver", /^An approver\b/, "An approver"],
];

const ticks = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
const startsNone = (cell: string) => /^None\b/.test(cell);
const shown = (ps: readonly Param[]) => `(${ps.map((p) => `${p.name}: ${p.type}`).join(", ")})`;

/** Every way the rows and the code disagree, each named. Empty when they agree. */
function mismatches(
  contract: string,
  table: RefTable,
  c: Contract,
  errorCodes: ReadonlySet<string>,
  exempt: Exemptions = NO_EXEMPTIONS,
): string[] {
  const problems: string[] = [];
  const rowName = (r: RefRow) => /^`([A-Za-z_]\w*)`$/.exec(r.cells.method ?? "")?.[1] ?? "";
  const rows = new Map<string, RefRow>();
  for (const r of table.rows) {
    const name = rowName(r);
    if (name === "") problems.push(`${contract}: a row's method cell is not one name in backticks`);
    else if (rows.has(name)) problems.push(`${contract}: \`${name}\` has two rows`);
    else rows.set(name, r);
  }
  const inCode = new Map<string, RustMethod>();
  for (const m of c.methods) {
    if (inCode.has(m.name)) problems.push(`${contract}: \`${m.name}\` is defined twice`);
    inCode.set(m.name, m);
    if (!rows.has(m.name)) {
      problems.push(`${contract}: \`${m.name}\` (${m.file}) is in the code but has no row`);
    }
  }
  const events = new Set([...c.events.values()].flatMap((s) => [...s]));
  for (const [name, r] of rows) {
    const m = inCode.get(name);
    if (!m) {
      problems.push(`${contract}: the row \`${name}\` names no method in the code`);
      continue;
    }
    const at = `${contract} \`${name}\``;
    const cells = r.cells;
    if (r.id !== `${contract}-${name}`)
      problems.push(`${at}: its row id must be ${contract}-${name}`);
    const kind = kindOf(m);
    if (cells.kind !== kind) {
      problems.push(`${at}: documented as ${cells.kind ?? "nothing"}, the code makes it ${kind}`);
    }
    const payable = m.attrs.includes("payable");
    if (payable && startsNone(cells.deposit ?? "")) {
      problems.push(`${at}: #[payable] in the code, but its deposit reads None`);
    }
    if (!payable && cells.deposit !== "None") {
      problems.push(`${at}: not #[payable] in the code, so its deposit must read None`);
    }
    const documented = ticks(cells.args ?? "").flatMap((t) => {
      const p = /^([A-Za-z_]\w*):\s*(.+)$/.exec(t);
      return p ? [{ name: p[1] ?? "", type: squash(p[2] ?? "") }] : [];
    });
    if (
      m.params.length === 0 ? !startsNone(cells.args ?? "") : shown(documented) !== shown(m.params)
    ) {
      problems.push(
        `${at}: arguments documented as ${shown(documented)}, the code takes ${shown(m.params)}`,
      );
    }
    const none = m.returns === null || m.returns === "Self";
    const firstTick = ticks(cells.returns ?? "")[0];
    if (none ? !startsNone(cells.returns ?? "") : squash(firstTick ?? "") !== m.returns) {
      problems.push(
        `${at}: returns documented as ${none ? "a type" : `\`${firstTick ?? "nothing"}\``}, the code returns ${m.returns ?? "nothing"}`,
      );
    }

    const codeExempt = exempt.codes[r.id ?? ""] ?? {};
    const eventExempt = exempt.events[r.id ?? ""] ?? {};
    const trace = traceOf(
      m,
      c,
      new Set(Object.keys(codeExempt)),
      (cb) => new Set(Object.keys(exempt.events[`${contract}-${cb}`] ?? {})),
    );

    // The deposit rule and the caller.
    const oneYocto = trace.reached.has("require_one_yocto");
    if (oneYocto !== (cells.deposit === ONE_YOCTO_CELL)) {
      problems.push(
        oneYocto
          ? `${at}: the code calls require_one_yocto, so its deposit must read ${ONE_YOCTO_CELL}`
          : `${at}: its deposit reads ${ONE_YOCTO_CELL}, but the code never calls require_one_yocto`,
      );
    }
    for (const [guard, pattern, words] of ROLES) {
      const checks = trace.reached.has(guard);
      if (checks !== pattern.test(cells.who ?? "")) {
        problems.push(
          checks
            ? `${at}: the code calls ${guard}, so its caller cell must start with ${words}`
            : `${at}: its caller cell starts with ${words}, but the code never calls ${guard}`,
        );
      }
    }
    for (const callee of Object.keys(codeExempt)) {
      if (!trace.reached.has(callee)) {
        problems.push(
          `${at}: its code exemption names \`${callee}\`, which the method never calls`,
        );
      }
    }
    for (const e of Object.keys(eventExempt)) {
      if (!trace.events.has(e)) {
        problems.push(`${at}: its event exemption names \`${e}\`, which its code never logs`);
      }
    }

    // Events: its own receipt's, and its callbacks', each callback named.
    const eventTicks = ticks(cells.events ?? "");
    const namedEvents = eventTicks.filter((t) => events.has(t));
    for (const t of eventTicks) {
      if (!events.has(t) && !trace.callbacks.has(t)) {
        problems.push(
          `${at}: \`${t}\` is neither an event of the ${contract} nor a callback it schedules`,
        );
      }
    }
    for (const e of trace.events) {
      if (!namedEvents.includes(e) && !(e in eventExempt)) {
        problems.push(`${at}: the code emits \`${e}\`, its row does not name it`);
      }
    }
    for (const [cb, evs] of trace.callbacks) {
      for (const e of evs) {
        if (!namedEvents.includes(e) && !trace.events.has(e)) {
          problems.push(`${at}: its callback \`${cb}\` emits \`${e}\`, its row does not name it`);
        }
      }
    }
    for (const e of namedEvents) {
      if (trace.events.has(e)) continue;
      const from = [...trace.callbacks].filter(([, evs]) => evs.has(e)).map(([cb]) => cb);
      if (from.length === 0)
        problems.push(`${at}: its row names \`${e}\`, which the code never emits`);
      else if (!from.some((cb) => eventTicks.includes(cb))) {
        problems.push(
          `${at}: \`${e}\` comes from the callback \`${from.join("` or `")}\`, which its row must name`,
        );
      }
    }

    // Codes: the same set, in the same order.
    const namedCodes = [
      ...new Set(ticks(cells.errors ?? "").filter((t) => /^[A-Z][A-Za-z]+$/.test(t))),
    ];
    for (const e of namedCodes) {
      if (!errorCodes.has(e)) problems.push(`${at}: \`${e}\` is not a vault error code`);
    }
    for (const e of trace.codes) {
      if (!namedCodes.includes(e))
        problems.push(`${at}: the code raises \`${e}\`, its row does not name it`);
    }
    for (const e of namedCodes) {
      if (errorCodes.has(e) && !trace.codes.includes(e)) {
        problems.push(`${at}: its row names \`${e}\`, which the code never raises`);
      }
    }
    const rowOrder = namedCodes.filter((e) => trace.codes.includes(e));
    const codeOrder = trace.codes.filter((e) => namedCodes.includes(e));
    if (rowOrder.join() !== codeOrder.join()) {
      problems.push(
        `${at}: its row names the codes in the order ${rowOrder.join(", ")}, the code checks them in the order ${codeOrder.join(", ")}`,
      );
    }
  }
  const exemptRows = new Set([...Object.keys(exempt.codes), ...Object.keys(exempt.events)]);
  for (const id of exemptRows) {
    if (id.startsWith(`${contract}-`) && !table.rows.some((r) => r.id === id)) {
      problems.push(
        `${contract}: the exemptions name the row ${id}, which the table does not have`,
      );
    }
  }
  return problems;
}

// --- the real contracts --------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const repoPath = (abs: string) => relative(ROOT, abs).split(sep).join("/");

/** Every `.rs` file of a crate's `src`, except the files `lib.rs` declares as `#[cfg(test)] mod x;`. */
function crateSources(dir: string): { sources: Source[]; skipped: string[] } {
  const lib = blankRust(read(`${dir}/lib.rs`)).code;
  const skipped = [...lib.matchAll(/#\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*mod\s+(\w+)\s*;/g)].map(
    (m) => `${m[1] ?? ""}.rs`,
  );
  const sources = walkFiles(join(ROOT, dir), ".rs")
    .filter((f) => !skipped.includes(basename(f)))
    .map((f) => ({ file: repoPath(f), text: readFileSync(f, "utf8") }));
  return { sources, skipped };
}

const VAULT_SRC = crateSources("contracts/vault/src");
const FACTORY_SRC = crateSources("contracts/factory/src");
const VAULT = readContract(VAULT_SRC.sources);
const FACTORY = readContract(FACTORY_SRC.sources);
const ERROR_CODES = VAULT.errorCodes;

/**
 * The short list of what the rows leave out on purpose. Each helper here is a defensive check that
 * cannot fail once the method's own checks have passed, except `evaluate`, whose codes the `spend`
 * row names as the spend checks (pinned below by their count).
 */
const EXEMPTIONS: Exemptions = {
  codes: {
    "vault-spend": {
      evaluate: "Its codes are the spend checks, which the row names by their count.",
      reserve: "Defensive: evaluate has just found the mandate.",
      hold: "Defensive: reserve has just stored the spend as held.",
      execute_payout:
        "Defensive: the spend was just reserved, its mandate exists and create_mandate allowed its asset.",
    },
    "vault-approve": {
      execute_payout: "Defensive: approve has just found the spend held and its mandate active.",
    },
    "vault-reject": { release: "Defensive: held_spend has just found the spend held." },
    "vault-expire_held": { release: "Defensive: held_spend has just found the spend held." },
    "vault-on_transfer": {
      settle: "Defensive: a spend whose payout is out exists, and so does its mandate.",
      fail_spend: "Defensive: a spend whose payout is out exists, and so does its mandate.",
    },
    "vault-on_withdraw": {
      settle: "Defensive: a spend whose payout is out exists, and so does its mandate.",
      fail_spend: "Defensive: a spend whose payout is out exists, and so does its mandate.",
    },
    "factory-on_vault_created": {
      vault_account_id: "Defensive: create_vault has already parsed the same account id.",
    },
  },
  events: {
    "vault-on_transfer": {
      spend_burned:
        "settle logs it only for a burned spend, and on_transfer settles a spend as paid.",
    },
    "vault-on_withdraw": {
      spend_paid:
        "settle logs it unless the spend is burned to an Intents payee, and on_withdraw settles only such a spend.",
    },
  },
};

function table(id: string): RefTable {
  const t = TABLES.find((x) => x.id === id);
  if (!t) throw new Error(`no table ${id} in ref/contract.ts`);
  return t;
}
const VAULT_TABLE = table("contract-vault-methods");
const FACTORY_TABLE = table("contract-factory-methods");
const cell = (t: RefTable, id: string, key: string) =>
  t.rows.find((r) => r.id === id)?.cells[key] ?? `(no row ${id})`;

function methodNamed(c: Contract, name: string): RustMethod {
  const m = c.methods.find((x) => x.name === name);
  if (!m) throw new Error(`no method ${name}`);
  return m;
}

describe("the Rust reader", () => {
  const FIXTURE = `//! pub fn in_a_doc_comment(&self) {}
use near_sdk::near;

#[near(event_json(standard = "thing"))]
pub enum ThingEvent {
    #[event_version("1.0.0")]
    Paid { amount: U128 },
    #[event_version("1.0.0")]
    WentAway,
}

pub fn require_one_yocto() {
    if env::attached_deposit().as_yoctonear() != 1 {
        fail(ErrorCode::RequiresOneYocto)
    }
}

#[near]
impl Thing {
    #[init]
    pub fn new(owner: AccountId, limits: Vec<u64>) -> Self {
        Self { owner }
    }

    /// A view. pub fn not_this_one(&self) {}
    pub fn get(&self, id: u64) -> Option<View> {
        let s = "a { brace and pub fn fake(&self) and self.check(1) in a string";
        let c = '{';
        /* pub fn in_a_block_comment(&self) {} */
        self.inner(s, c)
    }

    #[payable]
    pub fn pay(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require_one_yocto();
        if amount.0 == 0 {
            fail(ErrorCode::InvalidInput)
        }
        if let Err(code) = self.check(amount) {
            fail(code)
        }
        ThingEvent::Paid { amount }.emit();
        Self::ext(env::current_account_id()).on_done(1)
    }

    #[private]
    pub fn on_done(&mut self, id: u64) {
        self.settle(id);
    }

    pub(crate) fn helper(&self) {}
    fn hidden(&self) {}
}

impl Thing {
    pub fn not_exported(&self) {}
    fn assert_owner(&self) {
        fail(ErrorCode::NotOwner)
    }
    fn check(&self, amount: U128) -> Result<(), ErrorCode> {
        if amount.0 > 10 {
            return Err(ErrorCode::TooMuch);
        }
        Self::limit()
    }
    fn limit() -> Result<(), ErrorCode> {
        fail(ErrorCode::NoLimit)
    }
    fn settle(&mut self, id: u64) {
        ThingEvent::WentAway.emit();
        fail(ErrorCode::Defensive)
    }
}

#[near]
impl Ext for Thing {
    fn from_trait(&mut self) {}
}

#[cfg(test)]
mod tests {
    #[near]
    impl Thing {
        pub fn test_only(&self) {}
    }
}
`;
  const thing = readContract([{ file: "thing.rs", text: FIXTURE }]);

  it("finds only the exported methods, with their receiver, attributes, arguments and return type", () => {
    expect(
      thing.methods.map((m) => [m.name, kindOf(m), m.attrs.join(" "), shown(m.params), m.returns]),
    ).toEqual([
      ["new", "init", "init", "(owner: AccountId, limits: Vec<u64>)", "Self"],
      ["get", "view", "", "(id: u64)", "Option<View>"],
      ["pay", "call", "payable", "(amount: U128)", "Promise"],
      ["on_done", "private callback", "private", "(id: u64)", null],
      ["from_trait", "call", "", "()", null],
    ]);
    expect([...thing.free.keys()]).toEqual(["require_one_yocto"]);
    expect([...thing.privates]).toEqual(["on_done"]);
  });

  it("follows a method through its helpers to the codes, events and callbacks it reaches", () => {
    expect([...(thing.events.get("ThingEvent") ?? [])]).toEqual(["paid", "went_away"]);
    const pay = traceOf(methodNamed(thing, "pay"), thing);
    // `check` returns TooMuch, which `pay` raises with `fail(code)`; `limit` raises NoLimit itself.
    expect(pay.codes).toEqual([
      "NotOwner",
      "RequiresOneYocto",
      "InvalidInput",
      "TooMuch",
      "NoLimit",
    ]);
    expect([...pay.reached].sort()).toEqual([
      "assert_owner",
      "check",
      "limit",
      "require_one_yocto",
    ]);
    expect([...pay.events]).toEqual(["paid"]);
    expect([...pay.callbacks].map(([name, evs]) => [name, [...evs]])).toEqual([
      ["on_done", ["went_away"]],
    ]);
    const onDone = methodNamed(thing, "on_done");
    expect(traceOf(onDone, thing).codes).toEqual(["Defensive"]);
    expect(traceOf(onDone, thing, new Set(["settle"])).codes).toEqual([]);
    expect(traceOf(onDone, thing, new Set(["settle"])).events).toEqual(new Set(["went_away"]));
    // `self.check(1)` inside a string is not a call.
    expect(traceOf(methodNamed(thing, "get"), thing).reached.size).toBe(0);
  });

  it("names each mismatch between a table and the code", () => {
    const row = (name: string, cells: Partial<Record<string, string>>): RefRow => ({
      id: `thing-${name}`,
      cells: {
        method: `\`${name}\``,
        kind: "call",
        who: "Anyone",
        deposit: "None",
        args: "None",
        returns: "None",
        events: "None",
        errors: "None",
        ...cells,
      } as Record<string, string>,
    });
    const fixture: RefTable = {
      id: "thing",
      label: "Thing",
      columns: [],
      rows: [
        row("new", {
          kind: "init",
          args: "`owner: AccountId`, `limits: Vec<u64>`",
          events: "`paid`",
          errors: "`InvalidInput`",
        }),
        row("get", { args: "`id: u32`", returns: "`View`" }),
        row("pay", {
          deposit: "Some NEAR",
          args: "`amount: U128`",
          returns: "`Promise`",
          events: "`gone`, `went_away`",
          errors: "`RequiresOneYocto`, `NotOwner`, `InvalidInput`, `TooMuch`",
        }),
        row("on_done", { kind: "private callback", args: "`id: u64`", events: "`went_away`" }),
        row("gone", {}),
      ],
    };
    const exempt: Exemptions = {
      codes: { "thing-on_done": { settle: "defensive" }, "thing-get": { nothing: "stale" } },
      events: { "thing-get": { paid: "stale" }, "thing-lost": { paid: "no such row" } },
    };
    const codes = new Set([
      "InvalidInput",
      "NotOwner",
      "RequiresOneYocto",
      "TooMuch",
      "NoLimit",
      "Defensive",
    ]);
    expect(mismatches("thing", fixture, thing, codes, exempt)).toEqual([
      "thing: `from_trait` (thing.rs) is in the code but has no row",
      "thing `new`: its row names `paid`, which the code never emits",
      "thing `new`: its row names `InvalidInput`, which the code never raises",
      "thing `get`: documented as call, the code makes it view",
      "thing `get`: arguments documented as (id: u32), the code takes (id: u64)",
      "thing `get`: returns documented as `View`, the code returns Option<View>",
      "thing `get`: its code exemption names `nothing`, which the method never calls",
      "thing `get`: its event exemption names `paid`, which its code never logs",
      "thing `pay`: the code calls require_one_yocto, so its deposit must read Exactly 1 yoctoNEAR",
      "thing `pay`: the code calls assert_owner, so its caller cell must start with The owner",
      "thing `pay`: `gone` is neither an event of the thing nor a callback it schedules",
      "thing `pay`: the code emits `paid`, its row does not name it",
      "thing `pay`: `went_away` comes from the callback `on_done`, which its row must name",
      "thing `pay`: the code raises `NoLimit`, its row does not name it",
      "thing `pay`: its row names the codes in the order RequiresOneYocto, NotOwner, InvalidInput, TooMuch, the code checks them in the order NotOwner, RequiresOneYocto, InvalidInput, TooMuch",
      "thing: the row `gone` names no method in the code",
      "thing: the exemptions name the row thing-lost, which the table does not have",
    ]);
  });
});

describe("the contract reference", () => {
  it("reads every source file of each crate except its test modules", () => {
    expect(VAULT_SRC.skipped).toEqual(["test_utils.rs"]);
    expect(FACTORY_SRC.skipped).toEqual(["tests.rs"]);
    expect(VAULT_SRC.sources.map((s) => s.file)).toContain("contracts/vault/src/spend.rs");
    expect(FACTORY_SRC.sources.map((s) => s.file)).toEqual(["contracts/factory/src/lib.rs"]);
    expect(VAULT.methods.length).toBeGreaterThan(20);
    expect(ERROR_CODES.size).toBe(24);
    expect([...VAULT.events.keys()]).toEqual(["VaultEvent"]);
    expect([...FACTORY.events.keys()]).toEqual(["FactoryEvent"]);
    // The helpers the trace follows are found, so a code raised through one cannot slip by.
    for (const helper of [
      "assert_owner",
      "assert_approver",
      "held_spend",
      "execute_payout",
      "evaluate",
    ]) {
      expect(VAULT.impl.has(helper), helper).toBe(true);
    }
    expect(VAULT.free.has("require_one_yocto")).toBe(true);
    expect(FACTORY.impl.has("internal_store_code")).toBe(true);
    expect(FACTORY.free.has("require_one_yocto")).toBe(true);
    expect([...VAULT.privates].sort()).toEqual(["on_transfer", "on_withdraw"]);
    expect([...FACTORY.privates]).toEqual(["on_vault_created"]);
  });

  it("gives both tables the same eight columns", () => {
    for (const t of TABLES) {
      expect(
        t.columns.map((c) => c.key),
        t.id,
      ).toEqual(["method", "kind", "who", "deposit", "args", "returns", "events", "errors"]);
    }
    expect(TABLES.map((t) => t.id)).toEqual(["contract-vault-methods", "contract-factory-methods"]);
  });

  it("documents every vault method, and only those, as the code defines them", () => {
    expect(mismatches("vault", VAULT_TABLE, VAULT, ERROR_CODES, EXEMPTIONS)).toEqual([]);
  });

  it("documents every factory method, and only those, as the code defines them", () => {
    expect(mismatches("factory", FACTORY_TABLE, FACTORY, ERROR_CODES, EXEMPTIONS)).toEqual([]);
  });

  it("gives every exemption a reason", () => {
    const reasons = [
      ...Object.values(EXEMPTIONS.codes),
      ...Object.values(EXEMPTIONS.events),
    ].flatMap((r) => Object.values(r));
    expect(reasons.filter((why) => why.trim() === "")).toEqual([]);
  });

  it("names the spend checks by their count, on the spend row and on the page", () => {
    const evaluate = VAULT.impl.get("evaluate") ?? [];
    const checks = new Set(
      evaluate.flatMap((b) =>
        sitesOf(b, VAULT).flatMap((s) => (s.kind === "return" ? [s.code] : [])),
      ),
    );
    expect(checks.size).toBeGreaterThan(0);
    expect(cell(VAULT_TABLE, "vault-spend", "errors")).toContain(`the ${checks.size} spend checks`);
    expect(readMdx("build/contract-reference")).toContain(`The ${checks.size} checks`);
  });

  it("shows the limits the code sets", () => {
    const vaultLib = read("contracts/vault/src/lib.rs");
    const factoryLib = read("contracts/factory/src/lib.rs");
    const int = (src: string, name: string) => {
      const m = new RegExp(`const ${name}\\s*:\\s*\\w+\\s*=\\s*([\\d_]+)\\s*;`).exec(src);
      if (!m) throw new Error(`${name} is no longer a plain integer constant: update this pin`);
      return Number((m[1] ?? "").replace(/_/g, ""));
    };
    const ttl = /const MAX_HELD_TTL_NS\s*:\s*u64\s*=\s*(\d+)\s*\*\s*DAY_NS\s*;/.exec(vaultLib);
    if (!ttl) throw new Error("MAX_HELD_TTL_NS is no longer N * DAY_NS: update this pin");
    const label = /label\.len\(\)\s*>\s*(\d+)/.exec(read("contracts/vault/src/keys.rs"));
    const want: [string, string, string][] = [
      ["vault-new", "errors", `or more than ${int(vaultLib, "MAX_APPROVERS")},`],
      ["vault-new", "errors", `more than ${int(vaultLib, "MAX_ASSETS")} allowed assets`],
      ["vault-new", "errors", `over ${ttl[1] ?? ""} days`],
      ["vault-add_agent", "errors", `${int(vaultLib, "MAX_AGENTS")} agents already`],
      ["vault-add_agent", "errors", `a label over ${label?.[1] ?? "?"} bytes`],
      ["vault-list_mandates", "returns", `up to ${int(vaultLib, "MAX_PAGE")} `],
      ["vault-list_spends", "returns", `up to ${int(vaultLib, "MAX_PAGE")} `],
      ["vault-list_anchors", "returns", `up to ${int(vaultLib, "MAX_PAGE")} `],
    ];
    const factory: [string, string, string][] = [
      ["factory-new", "errors", `more than ${int(factoryLib, "MAX_ASSETS")} allowed assets`],
      ["factory-add_version", "errors", `notes over ${int(factoryLib, "MAX_NOTES")} bytes`],
      ["factory-list_vaults", "returns", `up to ${int(factoryLib, "MAX_PAGE")} `],
    ];
    const missing = [
      ...want.filter(([id, key, text]) => !cell(VAULT_TABLE, id, key).includes(text)),
      ...factory.filter(([id, key, text]) => !cell(FACTORY_TABLE, id, key).includes(text)),
    ];
    expect(missing).toEqual([]);
    const deposit =
      /USDC_STORAGE_DEPOSIT\s*:\s*NearToken\s*=\s*NearToken::from_yoctonear\(([\d_]+)\)/.exec(
        vaultLib,
      );
    if (!deposit) throw new Error("USDC_STORAGE_DEPOSIT changed form: update this pin");
    const near = nearOf(BigInt((deposit[1] ?? "").replace(/_/g, "")));
    expect(cell(VAULT_TABLE, "vault-create_mandate", "deposit")).toContain(`${near} NEAR`);
    expect(readMdx("build/contract-reference")).toContain(`at most ${int(vaultLib, "MAX_PAGE")}`);
  });
});

/** yoctoNEAR as a decimal NEAR amount: 1250000000000000000000 → "0.00125". */
function nearOf(yocto: bigint): string {
  const unit = 10n ** 24n;
  const frac = (yocto % unit).toString().padStart(24, "0").replace(/0+$/, "");
  return frac === "" ? `${yocto / unit}` : `${yocto / unit}.${frac}`;
}

describe("the deployed contracts on the page", () => {
  const page = readMdx("build/contract-reference");
  const testnet = JSON.parse(read("contracts/deployments/testnet.json")) as {
    accounts: Record<string, string>;
    factory: { owner: string; min_deposit: string; versions: { mode: string }[] };
  };
  const mainnet = JSON.parse(read("contracts/deployments/mainnet.json")) as {
    vault_v0: { account_id: string; code_hash: string | null; deploy_tx: string | null };
    factory: { account_id: string; deploy_tx: string | null };
  };

  it("names every testnet account of contracts/deployments, the factory owner and its min_deposit", () => {
    const ids = [...Object.values(testnet.accounts), testnet.factory.owner];
    expect(ids.filter((id) => !page.includes(`\`${id}\``))).toEqual([]);
    expect(page).toContain(`${nearOf(BigInt(testnet.factory.min_deposit))} NEAR`);
  });

  it("says testnet has no global version only while the record has none", () => {
    expect(testnet.factory.versions.map((v) => v.mode)).not.toContain("global");
    expect(page).toContain("no global version");
  });

  it("gives the recorded mainnet vault's code hash, and says the mainnet factory is not deployed while its record has no deploy", () => {
    expect(mainnet.vault_v0.deploy_tx, "the mainnet v0 run is recorded").not.toBeNull();
    expect(mainnet.vault_v0.code_hash).toBe("3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1");
    expect(mainnet.factory.deploy_tx, "a mainnet factory is recorded: update the page").toBeNull();
    expect(page).toContain(`\`${mainnet.vault_v0.account_id}\`, deployed and locked on 2026-11-11`);
    expect(page).toContain(`code hash \`${mainnet.vault_v0.code_hash}\``);
    expect(page).toContain(`\`${mainnet.factory.account_id}\``);
    expect(page).toContain("the factory is not deployed");
    expect(page).not.toMatch(/Mainnet is Planned/);
  });

  it("names the workspace's other contract crates as testnet stand-ins", () => {
    const members = /members\s*=\s*\[([^\]]*)\]/.exec(read("contracts/Cargo.toml"))?.[1] ?? "";
    const crates = [...members.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    const others = crates.filter((m) => !["vault", "factory", "integration-tests"].includes(m));
    expect(others.length).toBeGreaterThan(0);
    expect(others.filter((m) => !page.includes(`\`${m}\``))).toEqual([]);
  });
});
