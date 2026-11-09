import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { EVENT_STANDARD, EVENT_VERSION, FACTORY_EVENT_STANDARD } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { TABLES } from "@/lib/docs/ref/events";
import type { RefRow, RefTable } from "@/lib/docs/ref/types";
import { ROOT, readMdx, walkFiles } from "./docs-helpers";

// The events reference (/docs/build/events), pinned to the contract source. The Rust is parsed
// here, on its own, so an event, a field, a type, a standard, a version, a function that builds an
// event or a method whose receipt logs one, added to or taken from the code, fails this test until
// ref/events.ts and the page follow.

/** Which documented table and which column of the line table cover which event enum. */
const DOCUMENTED = [
  { table: "events-vault", column: "vault", crate: "contracts/vault/src", enumName: "VaultEvent" },
  {
    table: "events-factory",
    column: "factory",
    crate: "contracts/factory/src",
    enumName: "FactoryEvent",
  },
] as const;

// --- Rust source, read independently of the docs data ----------------------------------------------

const RAW_STRING = /r(#*)"/y;
const CHAR_LITERAL = /'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'/y;

/** Blanks comments and the insides of string and char literals. Every offset stays the same. */
function mask(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
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
      blank(i, j);
      i = j;
      continue;
    }
    RAW_STRING.lastIndex = i;
    const raw = c === "r" && !/[A-Za-z0-9_]/.test(src[i - 1] ?? "") ? RAW_STRING.exec(src) : null;
    if (raw) {
      const close = `"${raw[1]}`;
      const start = i + raw[0].length;
      const end = src.indexOf(close, start);
      if (end === -1) throw new Error(`unterminated raw string at ${i}`);
      blank(start, end);
      i = end + close.length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === "'") {
      CHAR_LITERAL.lastIndex = i;
      const ch = CHAR_LITERAL.exec(src);
      if (ch) {
        blank(i + 1, i + ch[0].length - 1);
        i += ch[0].length;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

/** The index of the bracket that closes the one at `open`, in masked text. */
function closing(text: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const opener = text[open] ?? "";
  const closer = pairs[opener];
  if (closer === undefined) throw new Error(`no bracket at ${open}`);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === opener) depth++;
    else if (text[i] === closer && --depth === 0) return i;
  }
  throw new Error(`unclosed ${opener} at ${open}`);
}

/** Blanks every `#[cfg(test)] mod x { ... }` and `#[cfg(test)] mod x;`, keeping offsets. */
function withoutTests(masked: string): string {
  let s = masked;
  const head = /#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*([;{])/;
  for (let m = head.exec(s); m !== null; m = head.exec(s)) {
    const end = m[1] === ";" ? m.index + m[0].length : closing(s, m.index + m[0].length - 1) + 1;
    s = s.slice(0, m.index) + " ".repeat(end - m.index) + s.slice(end);
  }
  return s;
}

interface SourceFile {
  path: string;
  src: string;
  /** Masked, and with the test modules blanked. */
  code: string;
}

/** The files a crate compiles outside tests: `src/**.rs`, less the modules declared `#[cfg(test)] mod x;`. */
function crateFiles(crate: string): SourceFile[] {
  const dir = join(ROOT, crate);
  const all = walkFiles(dir, ".rs").map((path) => {
    const src = readFileSync(path, "utf8");
    return { path, src, masked: mask(src) };
  });
  const testOnly = new Set<string>();
  for (const f of all) {
    for (const m of f.masked.matchAll(
      /#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g,
    )) {
      testOnly.add(join(dirname(f.path), `${m[1]}.rs`));
      testOnly.add(join(dirname(f.path), m[1] ?? "", "mod.rs"));
    }
  }
  return all
    .filter((f) => !testOnly.has(f.path))
    .map((f) => ({ path: f.path, src: f.src, code: withoutTests(f.masked) }));
}

interface Field {
  name: string;
  type: string;
}
interface Variant {
  name: string;
  attrs: string[];
  fields: Field[];
}

/** Removes all whitespace, so `Option< String >` and `Option<String>` compare equal. */
const squash = (type: string) => type.replace(/\s+/g, "");

/** serde's `rename_all = "snake_case"`: an underscore before every upper-case letter but the first. */
const snake = (name: string) =>
  name.replace(/[A-Z]/g, (c, at: number) => (at > 0 ? "_" : "") + c.toLowerCase());

/** Splits at the commas outside any bracket. */
function topLevelParts(masked: string, original: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "<" || c === "(" || c === "[" || c === "{") depth++;
    else if (c === ">" || c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(original.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(original.slice(from));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function parseFields(masked: string, original: string, where: string): Field[] {
  return topLevelParts(masked, original).map((part) => {
    if (part.startsWith("#")) throw new Error(`${where}: a field attribute; extend this test`);
    const m = /^(?:pub(?:\([^)]*\))?\s+)?(\w+)\s*:\s*([\s\S]+)$/.exec(part);
    if (!m?.[1] || !m[2]) throw new Error(`${where}: cannot read the field "${part}"`);
    return { name: m[1], type: squash(m[2]) };
  });
}

/** The variants of an enum body (`masked` and `original` are the text between its braces). */
function parseVariants(masked: string, original: string, where: string): Variant[] {
  const variants: Variant[] = [];
  let attrs: string[] = [];
  let i = 0;
  while (i < masked.length) {
    const c = masked[i] ?? "";
    if (/[\s,]/.test(c)) {
      i++;
      continue;
    }
    if (c === "#") {
      const open = masked.indexOf("[", i);
      const close = closing(masked, open);
      attrs.push(original.slice(open + 1, close).trim());
      i = close + 1;
      continue;
    }
    const ident = /^[A-Za-z_]\w*/.exec(masked.slice(i));
    if (!ident) throw new Error(`${where}: unexpected "${masked.slice(i, i + 20)}"`);
    const name = ident[0];
    i += name.length;
    while (/\s/.test(masked[i] ?? "")) i++;
    let fields: Field[] = [];
    if (masked[i] === "{") {
      const close = closing(masked, i);
      fields = parseFields(
        masked.slice(i + 1, close),
        original.slice(i + 1, close),
        `${where} ${name}`,
      );
      i = close + 1;
    } else if (masked[i] === "(") {
      throw new Error(`${where} ${name}: a tuple variant; extend this test`);
    } else if (masked[i] === "=") {
      throw new Error(`${where} ${name}: a discriminant; extend this test`);
    }
    variants.push({ name, attrs, fields });
    attrs = [];
  }
  return variants;
}

/** The body of the first `pub enum <name>` in the crate's non-test code, with the attributes above it. */
function findEnum(
  files: SourceFile[],
  name: string,
): { file: SourceFile; attrs: string; variants: Variant[] } {
  for (const file of files) {
    const m = new RegExp(`((?:#\\[[^\\]]*\\]\\s*)*)pub\\s+enum\\s+${name}\\s*\\{`).exec(file.code);
    if (!m) continue;
    const open = m.index + m[0].length - 1;
    const close = closing(file.code, open);
    const attrs = file.src.slice(m.index, m.index + (m[1] ?? "").length);
    const variants = parseVariants(
      file.code.slice(open + 1, close),
      file.src.slice(open + 1, close),
      `${relative(ROOT, file.path)} ${name}`,
    );
    return { file, attrs, variants };
  }
  throw new Error(`pub enum ${name} not found`);
}

interface EventVariant extends Variant {
  event: string;
  version: string;
}
interface EventEnum {
  crate: string;
  file: string;
  enumName: string;
  standard: string;
  variants: EventVariant[];
}

/** Every `#[near(event_json(...))] pub enum` in a crate's non-test code. */
function eventEnums(crate: string): EventEnum[] {
  const out: EventEnum[] = [];
  for (const file of crateFiles(crate)) {
    for (const at of file.code.matchAll(/#\[near\(\s*event_json\b/g)) {
      const head =
        /#\[near\(\s*event_json\s*\(\s*standard\s*=\s*"([^"]*)"\s*\)\s*\)\]\s*(?:#\[[^\]]*\]\s*)*pub\s+enum\s+(\w+)\s*\{/y;
      head.lastIndex = at.index ?? 0;
      const m = head.exec(file.src);
      const where = `${relative(ROOT, file.path)}:${at.index ?? 0}`;
      if (!m?.[1] || !m[2])
        throw new Error(`${where}: an event_json attribute this test cannot read`);
      const open = head.lastIndex - 1;
      const close = closing(file.code, open);
      const variants = parseVariants(
        file.code.slice(open + 1, close),
        file.src.slice(open + 1, close),
        `${where} ${m[2]}`,
      ).map((v): EventVariant => {
        const version = /^event_version\(\s*"([^"]+)"\s*\)$/.exec(v.attrs[0] ?? "")?.[1];
        if (v.attrs.length !== 1 || version === undefined) {
          throw new Error(
            `${where} ${v.name}: expected exactly #[event_version("...")], got ${v.attrs.join(" ")}`,
          );
        }
        return { ...v, event: snake(v.name), version };
      });
      out.push({
        crate,
        file: relative(ROOT, file.path).split(sep).join("/"),
        enumName: m[2],
        standard: m[1],
        variants,
      });
    }
  }
  return out;
}

/** Every crate under contracts/ that has a src directory. */
function crates(): string[] {
  return readdirSync(join(ROOT, "contracts"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, "contracts", d.name, "src")))
    .map((d) => `contracts/${d.name}/src`)
    .sort();
}

/** For each variant of `enumName`, the functions whose body names `<enumName>::<Variant>`. */
function emitSites(crate: string, enumName: string): Map<string, Set<string>> {
  const sites = new Map<string, Set<string>>();
  for (const file of crateFiles(crate)) {
    for (const m of file.code.matchAll(new RegExp(`\\b${enumName}::(\\w+)\\b`, "g"))) {
      const fns = [...file.code.slice(0, m.index ?? 0).matchAll(/\bfn\s+(\w+)/g)];
      const fn = fns.at(-1)?.[1];
      if (!fn || !m[1]) throw new Error(`${relative(ROOT, file.path)}: ${m[0]} outside any fn`);
      const set = sites.get(m[1]) ?? new Set<string>();
      set.add(fn);
      sites.set(m[1], set);
    }
  }
  return sites;
}

interface Call {
  callee: string;
  /** The masked text between the call's parentheses. */
  args: string;
}
interface FnDef {
  name: string;
  /** A method of a `#[near] impl` that the contract exports: a receipt can run it. */
  exported: boolean;
  /** `self.f(...)`, `Self::f(...)` and `f(...)`: code that runs in the same receipt. */
  calls: Call[];
  /** `.f(...)` on anything but `self`, as in `Self::ext(..).f(...)`: a call run as another receipt. */
  schedules: string[];
}

/** Every `fn` a crate defines outside tests, with what its body calls and schedules. */
function fnDefs(crate: string): FnDef[] {
  const out: FnDef[] = [];
  for (const file of crateFiles(crate)) {
    const code = file.code;
    const blocks: { from: number; to: number; traitImpl: boolean }[] = [];
    for (const m of code.matchAll(/#\[near\]\s*(?:#\[[^\]]*\]\s*)*impl\b([^{;]*)\{/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      blocks.push({ from: open, to: closing(code, open), traitImpl: /\bfor\b/.test(m[1] ?? "") });
    }
    for (const m of code.matchAll(/\b(pub(?:\([^)]*\))?\s+)?fn\s+(\w+)/g)) {
      const at = m.index ?? 0;
      // The body opens at the first `{` outside the signature's brackets. A `;` first: no body.
      let open = -1;
      let depth = 0;
      for (let i = at + m[0].length; i < code.length; i++) {
        const c = code[i];
        if (c === "(" || c === "[") depth++;
        else if (c === ")" || c === "]") depth--;
        else if (depth === 0 && c === ";") break;
        else if (depth === 0 && c === "{") {
          open = i;
          break;
        }
      }
      if (open === -1) continue;
      const close = closing(code, open);
      const body = code.slice(open, close + 1);
      const block = blocks.find((b) => at > b.from && at < b.to);
      const calls: Call[] = [];
      const schedules: string[] = [];
      for (const c of body.matchAll(/(\.\s*|\bSelf\s*::\s*|(?<![\w:.]))(\w+)\s*\(/g)) {
        const paren = (c.index ?? 0) + c[0].length - 1;
        const args = body.slice(paren + 1, closing(body, paren));
        const dotted = (c[1] ?? "").startsWith(".");
        const onSelf = dotted && /\bself\s*$/.test(body.slice(0, c.index ?? 0));
        if (dotted && !onSelf) schedules.push(c[2] ?? "");
        else calls.push({ callee: c[2] ?? "", args });
      }
      out.push({
        name: m[2] ?? "",
        exported: block !== undefined && (/^pub\s+$/.test(m[1] ?? "") || block.traitImpl),
        calls,
        schedules,
      });
    }
  }
  return out;
}

/**
 * Which functions log `variant` in their own receipt, read from the call graph: the builders, and
 * every fn that calls one in the same receipt. A builder of several variants (`settle`) builds the
 * one its caller picks with a path argument: `SpendStatus::Paid` picks the variant ending in `Paid`.
 */
function reachers(defs: FnDef[], builds: Map<string, Set<string>>, variant: string): Set<string> {
  const byName = new Map<string, FnDef[]>();
  for (const d of defs) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
  const picks = (callee: string, own: Set<string>, args: string): string => {
    const hits = [...args.matchAll(/\b\w+::(\w+)\b/g)]
      .map((p) => [...own].filter((v) => v.endsWith(p[1] ?? "")))
      .filter((v) => v.length === 1)
      .map((v) => v[0] ?? "");
    if (new Set(hits).size !== 1)
      throw new Error(`${callee}(${args.trim()}) builds ${[...own].join(", ")}; extend this test`);
    return hits[0] ?? "";
  };
  const memo = new Map<string, boolean>();
  const through = (name: string): boolean => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    memo.set(name, false);
    const hit = (byName.get(name) ?? []).some((d) =>
      d.calls.some((c) => {
        if (!byName.has(c.callee)) return false;
        const own = builds.get(c.callee) ?? new Set<string>();
        if (own.has(variant) && (own.size === 1 || picks(c.callee, own, c.args) === variant))
          return true;
        return through(c.callee);
      }),
    );
    memo.set(name, hit);
    return hit;
  };
  const out = new Set<string>();
  for (const name of byName.keys()) {
    if ((builds.get(name)?.has(variant) ?? false) || through(name)) out.add(name);
  }
  return out;
}

/** emitSites inverted: for each fn, the variants it builds itself. */
function buildsOf(sites: Map<string, Set<string>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [variant, fns] of sites) {
    for (const fn of fns) out.set(fn, new Set([...(out.get(fn) ?? []), variant]));
  }
  return out;
}

// --- the documented side --------------------------------------------------------------------------

const table = (id: string): RefTable => {
  const t = TABLES.find((x) => x.id === id);
  if (!t) throw new Error(`ref/events.ts has no table "${id}"`);
  return t;
};
const row = (t: RefTable, id: string): RefRow => {
  const r = t.rows.find((x) => x.id === id);
  if (!r) throw new Error(`${t.id} has no row "${id}"`);
  return r;
};
const ticks = (cell: string | undefined): string[] =>
  [...(cell ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
/** A cell that is exactly one backticked token. */
const only = (cell: string | undefined, what: string): string => {
  const m = /^`([^`]+)`$/.exec(cell ?? "");
  if (!m?.[1]) throw new Error(`${what}: "${cell}" is not one code token`);
  return m[1];
};
/** A data cell: `name: Type` tokens joined by commas, or "None". */
function documentedFields(cell: string | undefined, what: string): Field[] {
  if (cell === "None") return [];
  const rest = (cell ?? "").replace(/`[^`]+`/g, "").replace(/[,\s]/g, "");
  if (rest !== "") throw new Error(`${what}: the data cell has text outside its fields: "${rest}"`);
  return ticks(cell).map((t) => {
    const m = /^(\w+): (.+)$/.exec(t);
    if (!m?.[1] || !m[2]) throw new Error(`${what}: "${t}" is not "name: Type"`);
    return { name: m[1], type: squash(m[2]) };
  });
}

const ALL = crates().flatMap(eventEnums);
const enumOf = (d: (typeof DOCUMENTED)[number]): EventEnum => {
  const e = ALL.find((x) => x.crate === d.crate && x.enumName === d.enumName);
  if (!e) throw new Error(`${d.crate} has no event enum ${d.enumName}`);
  return e;
};

describe("the event enums in the contracts", () => {
  it("are the vault's and the factory's, no more and no fewer", () => {
    expect(ALL.map((e) => `${e.crate} ${e.enumName}`).sort()).toEqual(
      DOCUMENTED.map((d) => `${d.crate} ${d.enumName}`).sort(),
    );
    for (const e of ALL) expect(e.variants.length, e.enumName).toBeGreaterThan(0);
  });

  it("are read as the contract's own test expects", () => {
    // events.rs pins `mandate_revoked` with `{"mandate_id": 7}` under the standard probarion 1.0.0.
    const vault = enumOf(DOCUMENTED[0]);
    const revoked = vault.variants.find((v) => v.name === "MandateRevoked");
    expect(vault.standard).toBe("probarion");
    expect(revoked?.event).toBe("mandate_revoked");
    expect(revoked?.version).toBe("1.0.0");
    expect(revoked?.fields).toEqual([{ name: "mandate_id", type: "u64" }]);
    expect(snake("LedgerKeySet")).toBe("ledger_key_set");
  });

  it("are traced through the call graph as the receipts run", () => {
    // A payout's callback runs in its own receipt: `execute_payout` schedules `on_transfer`, and only
    // the callback logs `spend_paid`. `settle` builds `spend_paid` or `spend_burned` by the status
    // each callback passes it.
    const vault = buildsOf(emitSites("contracts/vault/src", "VaultEvent"));
    const vaultDefs = fnDefs("contracts/vault/src");
    const paid = reachers(vaultDefs, vault, "SpendPaid");
    expect([...paid].sort()).toEqual(["on_transfer", "settle"]);
    expect([...reachers(vaultDefs, vault, "SpendHeld")].sort()).toEqual(["hold", "spend"]);
    expect([...reachers(vaultDefs, vault, "SpendSubmitted")].sort()).toEqual([
      "approve",
      "execute_payout",
      "spend",
    ]);
    const exported = new Set(vaultDefs.filter((x) => x.exported).map((x) => x.name));
    expect(exported.has("spend") && exported.has("on_withdraw")).toBe(true);
    expect(exported.has("settle") || exported.has("hold")).toBe(false);
    // The factory's `create_vault` logs nothing itself: it schedules the callback that does.
    const factory = buildsOf(emitSites("contracts/factory/src", "FactoryEvent"));
    const factoryDefs = fnDefs("contracts/factory/src");
    const created = reachers(factoryDefs, factory, "VaultCreated");
    expect([...created]).toEqual(["on_vault_created"]);
    expect(
      factoryDefs.find((x) => x.name === "create_vault")?.schedules.includes("on_vault_created"),
    ).toBe(true);
  });
});

describe("the events tables", () => {
  for (const d of DOCUMENTED) {
    describe(`${d.table} (${d.enumName})`, () => {
      const e = enumOf(d);
      const t = table(d.table);

      it("lists every event of the enum, in order, and nothing else", () => {
        const documented = t.rows.map((r, at) => only(r.cells.event, `${t.id} row ${at}`));
        expect(documented).toEqual(e.variants.map((v) => v.event));
        expect(t.rows.map((r) => r.id)).toEqual(e.variants.map((v) => `events-${v.event}`));
      });

      it("gives each event exactly its fields, with their types, in order", () => {
        for (const v of e.variants) {
          const r = row(t, `events-${v.event}`);
          expect(documentedFields(r.cells.data, `${t.id} ${v.event}`), v.event).toEqual(v.fields);
        }
      });

      it("names every function that builds the event and every method that logs it, and no other", () => {
        const sites = emitSites(d.crate, d.enumName);
        const builds = buildsOf(sites);
        const defs = fnDefs(d.crate);
        for (const v of e.variants) {
          const by = ticks(row(t, `events-${v.event}`).cells.by);
          const built = [...(sites.get(v.name) ?? [])];
          expect(built.length, `${v.event} is never built outside tests`).toBeGreaterThan(0);
          for (const fn of built) expect(by, `${v.event} is built in ${fn}`).toContain(fn);
          const reach = reachers(defs, builds, v.name);
          // Every exported method whose receipt logs the line is named.
          for (const m of defs.filter((x) => x.exported && reach.has(x.name)))
            expect(by, `${v.event} is logged by ${m.name}`).toContain(m.name);
          // Every name builds the line, runs code that does, or schedules a method that does, as
          // `create_vault` schedules `on_vault_created`.
          for (const name of by) {
            const logs = (s: string) =>
              reach.has(s) && defs.some((y) => y.name === s && y.exported);
            const schedules = defs.some((x) => x.name === name && x.schedules.some(logs));
            const why = `${v.event}: ${name} neither logs nor schedules it`;
            expect(reach.has(name) || schedules, why).toBe(true);
          }
        }
        // Every variant the code builds is a variant of the enum.
        expect([...sites.keys()].filter((k) => !e.variants.some((v) => v.name === k))).toEqual([]);
      });

      it("shows the enum's standard and version in the line table", () => {
        const line = table("events-line");
        expect(only(row(line, "events-line-standard").cells[d.column], "standard")).toBe(
          e.standard,
        );
        const version = only(row(line, "events-line-version").cells[d.column], "version");
        for (const v of e.variants) expect(v.version, v.event).toBe(version);
      });
    });
  }

  it("agree with the constants @probarion/core exports", () => {
    const [vault, factory] = DOCUMENTED.map(enumOf);
    expect(EVENT_STANDARD).toBe(vault?.standard);
    expect(FACTORY_EVENT_STANDARD).toBe(factory?.standard);
    for (const e of ALL) for (const v of e.variants) expect(EVENT_VERSION, v.event).toBe(v.version);
  });

  it("explain every field type the events use, and no other", () => {
    const used = new Set(
      ALL.flatMap((e) => e.variants.flatMap((v) => v.fields.map((f) => f.type))),
    );
    const types = table("events-types");
    const documented = types.rows.map((r, at) =>
      squash(only(r.cells.type, `events-types row ${at}`)),
    );
    expect(new Set(documented).size, "a type is listed twice").toBe(documented.length);
    expect([...documented].sort()).toEqual([...used].sort());
  });

  it("describe Payee and Chain as types.rs serialises them", () => {
    const files = crateFiles("contracts/vault/src");
    const types = table("events-types");
    const cellOf = (name: string) =>
      types.rows.find((r) => squash(only(r.cells.type, name)) === name)?.cells.json;

    const payee = findEnum(files, "Payee");
    const tag = /#\[serde\(([^\]]*)\)\]/.exec(payee.attrs)?.[1] ?? "";
    expect(tag, "Payee is snake_case").toMatch(/rename_all\s*=\s*"snake_case"/);
    const tagName = /tag\s*=\s*"([^"]+)"/.exec(tag)?.[1];
    expect(tagName, "Payee is internally tagged").toBeDefined();
    const payeeWords = new Set([
      tagName ?? "",
      ...payee.variants.map((v) => snake(v.name)),
      ...payee.variants.flatMap((v) => v.fields.map((f) => f.name)),
    ]);
    expect(new Set(ticks(cellOf("Payee")))).toEqual(payeeWords);

    const chain = findEnum(files, "Chain");
    expect(chain.attrs).toMatch(/rename_all\s*=\s*"snake_case"/);
    expect(chain.variants.every((v) => v.fields.length === 0)).toBe(true);
    expect(new Set(ticks(cellOf("Chain")))).toEqual(
      new Set(chain.variants.map((v) => snake(v.name))),
    );
  });

  it("list every reason spend_failed can carry", () => {
    const reasons = new Set<string>();
    for (const f of crateFiles("contracts/vault/src")) {
      for (const m of f.src.matchAll(/\bfail_spend\(\s*\w+\s*,\s*"([^"]*)"\s*\)/g)) {
        // Only calls in compiled, non-test code count: the masked copy keeps that code as it is.
        const at = m.index ?? 0;
        if (f.code.slice(at, at + "fail_spend(".length) === "fail_spend(") {
          reasons.add(m[1] ?? "");
        }
      }
    }
    expect(reasons.size).toBeGreaterThan(0);
    const meaning = row(table("events-vault"), "events-spend_failed").cells.meaning;
    const documented = ticks(meaning).filter((t) => t.startsWith("ft_"));
    expect(new Set(documented)).toEqual(reasons);
  });
});

describe("the events page", () => {
  const page = readMdx("build/events").replace(/\r\n/g, "\n");
  const standards = new Map(ALL.map((e) => [e.standard, e]));

  it("shows every table of ref/events.ts", () => {
    const shown = [...page.matchAll(/<RefTable id="([^"]+)" \/>/g)].map((m) => m[1]);
    expect([...shown].sort()).toEqual(TABLES.map((t) => t.id).sort());
  });

  it("gives example lines that parse and match an event of the source exactly", () => {
    const lines = page.split("\n").filter((l) => l.startsWith("EVENT_JSON:"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line.slice("EVENT_JSON:".length)) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(["standard", "version", "event", "data"]);
      const e = standards.get(String(parsed.standard));
      expect(e, `unknown standard ${String(parsed.standard)}`).toBeDefined();
      const v = e?.variants.find((x) => x.event === parsed.event);
      expect(v, `unknown event ${String(parsed.event)}`).toBeDefined();
      expect(parsed.version).toBe(v?.version);
      expect(Object.keys(parsed.data as object)).toEqual(v?.fields.map((f) => f.name));
    }
    // The spread-out JSON block is the same object as the first line.
    const block = /```json\n([\s\S]*?)\n```/.exec(page)?.[1];
    expect(block, "the page has a json block").toBeDefined();
    expect(JSON.parse(block ?? "")).toEqual(
      JSON.parse((lines[0] ?? "").slice("EVENT_JSON:".length)),
    );
  });

  it("quotes the attributes with the values the source uses", () => {
    const quoted = [...page.matchAll(/event_json\(standard = "([^"]+)"\)/g)].map((m) => m[1]);
    expect(quoted.length).toBeGreaterThan(0);
    for (const s of quoted) expect(standards.has(s ?? ""), `standard ${s}`).toBe(true);
    const versions = new Set(ALL.flatMap((e) => e.variants.map((v) => v.version)));
    const quotedVersions = [...page.matchAll(/event_version\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(quotedVersions.length).toBeGreaterThan(0);
    for (const v of quotedVersions) expect(versions.has(v ?? ""), `version ${v}`).toBe(true);
  });

  it("filters on the vault's standard in its script", () => {
    const literal = /const STANDARD = "([^"]+)";/.exec(page)?.[1];
    expect(literal).toBe(enumOf(DOCUMENTED[0]).standard);
  });

  it("links only its own source files that exist", () => {
    for (const m of page.matchAll(
      /https:\/\/github\.com\/probarion\/probarion\/blob\/main\/([^)\s]+)/g,
    )) {
      expect(existsSync(join(ROOT, m[1] ?? "")), m[1]).toBe(true);
    }
    // The page links the files that hold the two enums.
    for (const d of DOCUMENTED) expect(page).toContain(`blob/main/${enumOf(d).file}`);
  });
});
