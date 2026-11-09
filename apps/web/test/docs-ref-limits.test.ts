import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import * as core from "@probarion/core";
import * as sdk from "@probarion/sdk";
import { describe, expect, it } from "vitest";
import { VAULT_DEFAULTS } from "@/lib/config";
import { TABLES } from "@/lib/docs/ref/limits";
import type { RefRow, RefTable } from "@/lib/docs/ref/types";
import * as runway from "@/lib/near/runway";
import { FT_STORAGE_DEPOSIT, GAS, MANDATE_STORAGE_DEPOSIT, METHOD_DEPOSIT } from "@/lib/near/tx";
import { LIMITS } from "@/lib/ratelimit";
import { ROOT, readMdx, WEB, walkFiles } from "./docs-helpers";

// The limits page is pinned to the code. The Rust half parses contracts/vault/src and
// contracts/factory/src/lib.rs: every `pub const` of the two lib.rs files and every `MAX_*` must be a
// row whose value is the one the source computes, each state-changing method must be a deposit row
// that matches its `#[payable]` and `require_one_yocto()`, and each `GAS_*` must name the call it is
// attached to. The TypeScript half imports the modules that define the values, or parses the ones
// that load server code, and checks the tables show them, both ways: every exported MAX_/MIN_ of
// apps/web/src/lib (or a stated reason), every limit-like export of the SDK and core, each rate
// limiter with the routes that read it and what its bucket counts, and each key allowance. The scans
// read the source, never the rows, so a constant, a method or a limiter the code gains or loses fails
// here and names itself.

const PAGE = "build/limits-and-costs";

// --- the tables -----------------------------------------------------------------------------------

function table(id: string): RefTable {
  const t = TABLES.find((x) => x.id === id);
  if (!t) throw new Error(`limits: no table ${id}`);
  return t;
}

const cell = (r: RefRow, key: string): string => r.cells[key] ?? "";

/** The parts of a cell in backticks. */
const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

/** The first backticked name of a cell: the item the row is about. */
const subject = (r: RefRow, key: string): string => ticks(cell(r, key))[0] ?? "";

/** The row of `id` whose `key` cell is about `name`. */
function rowAbout(t: RefTable, key: string, name: string): RefRow | undefined {
  return t.rows.find((r) => subject(r, key) === name);
}

// --- formatting, written here on its own so that the module's own helpers are not trusted --------

const thousands = (n: number | bigint) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The cell, without backticks, starts with `lead`, and no further digit or thousands group follows it. */
const leads = (text: string, lead: string) =>
  new RegExp(`^${escapeRe(lead)}(?!\\d|,\\d)`).test(text.replace(/`/g, ""));

function nearDecimal(yocto: bigint): string {
  const one = 10n ** 24n;
  const frac = (yocto % one).toString().padStart(24, "0").replace(/0+$/, "");
  return frac === "" ? `${yocto / one}` : `${yocto / one}.${frac}`;
}

function windowWords(seconds: number): string {
  if (seconds === 60) return "a minute";
  if (seconds === 3600) return "an hour";
  if (seconds === 86_400) return "a day";
  if (seconds % 86_400 === 0) return `${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

// --- Rust source ----------------------------------------------------------------------------------

const VAULT_SRC = join(ROOT, "contracts", "vault", "src");
const VAULT_LIB = join(VAULT_SRC, "lib.rs");
const FACTORY_LIB = join(ROOT, "contracts", "factory", "src", "lib.rs");
const VALIDATE = join(VAULT_SRC, "validate.rs");
const VAULT_FILES = readdirSync(VAULT_SRC)
  .filter((f) => f.endsWith(".rs") && f !== "test_utils.rs")
  .map((f) => join(VAULT_SRC, f));

/** A Rust file up to its `#[cfg(test)] mod tests { ... }` block. */
function code(file: string): string {
  const text = readFileSync(file, "utf8");
  const at = text.search(/#\[cfg\(test\)\]\s*mod\s+\w+\s*\{/);
  return at === -1 ? text : text.slice(0, at);
}

/** The index of the bracket that closes the one at `open`. */
function closing(text: string, open: number, pair: "{}" | "()"): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === pair[0]) depth++;
    else if (text[i] === pair[1]) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${pair} at ${open}`);
}

interface RustConst {
  name: string;
  pub: boolean;
  expr: string;
}

function constsOf(file: string): Map<string, RustConst> {
  const out = new Map<string, RustConst>();
  const re =
    /^[ \t]*(pub(?:\([^)]*\))?\s+)?const\s+([A-Z][A-Z0-9_]*)\s*:\s*[^=]+?=\s*([\s\S]*?);/gm;
  for (const m of code(file).matchAll(re)) {
    const name = m[2] ?? "";
    out.set(name, { name, pub: Boolean(m[1]), expr: (m[3] ?? "").replace(/\s+/g, " ").trim() });
  }
  return out;
}

type Value =
  | { kind: "int"; n: bigint }
  | { kind: "yocto"; n: bigint }
  | { kind: "gas"; n: bigint }
  | { kind: "str"; s: string };

const int = (s: string) => BigInt(s.replace(/_/g, ""));

/** A constant's value: a literal, a `NearToken`, a `Gas`, or a product of literals and constants. */
function evaluate(c: RustConst, scope: Map<string, RustConst>): Value {
  const e = c.expr;
  const str = /^"((?:[^"\\]|\\.)*)"$/.exec(e);
  if (str) return { kind: "str", s: str[1] ?? "" };
  const yocto = /^NearToken::from_yoctonear\(([\d_]+)\)$/.exec(e);
  if (yocto) return { kind: "yocto", n: int(yocto[1] ?? "") };
  const gas = /^Gas::from_tgas\(([\d_]+)\)$/.exec(e);
  if (gas) return { kind: "gas", n: int(gas[1] ?? "") };
  let n = 1n;
  for (const factor of e.split("*").map((f) => f.trim())) {
    const ref = scope.get(factor);
    if (/^[\d_]+$/.test(factor)) n *= int(factor);
    else if (ref) {
      const v = evaluate(ref, scope);
      if (v.kind !== "int") throw new Error(`${c.name}: ${factor} is not an integer`);
      n *= v.n;
    } else throw new Error(`${c.name}: cannot evaluate ${e}; teach the test this form`);
  }
  return { kind: "int", n };
}

/** Whether a cell shows the value the source computes. */
function shows(text: string, v: Value): boolean {
  switch (v.kind) {
    case "int":
      return leads(text, thousands(v.n));
    case "gas":
      return leads(text, `${v.n} Tgas`);
    case "yocto": {
      if (!leads(text, `${thousands(v.n)} yoctoNEAR`)) return false;
      const near = /\(([\d.]+) NEAR\)/.exec(text);
      return near === null || near[1] === nearDecimal(v.n);
    }
    case "str":
      return text.includes(`\`${v.s}\``);
  }
}

interface RustFn {
  name: string;
  pub: boolean;
  attrs: string[];
  receiver: "&self" | "&mut self" | null;
  body: string;
  /** Inside a `#[near] impl` block: part of the contract's ABI. */
  near: boolean;
  file: string;
}

function fnsOf(file: string): RustFn[] {
  const text = code(file);
  const blocks = [...text.matchAll(/#\[near\]\s*impl\s+\w+\s*\{/g)].map((m) => {
    const open = (m.index ?? 0) + m[0].length - 1;
    return [open, closing(text, open, "{}")] as const;
  });
  const out: RustFn[] = [];
  for (const m of text.matchAll(/\bfn\s+(\w+)\s*\(/g)) {
    const at = m.index ?? 0;
    const lineStart = text.lastIndexOf("\n", at) + 1;
    const attrs: string[] = [];
    const above = text.slice(0, lineStart).split("\n");
    above.pop();
    for (let i = above.length - 1; i >= 0; i--) {
      const line = (above[i] ?? "").trim();
      if (line.startsWith("#[")) attrs.push(line);
      else if (!line.startsWith("//")) break;
    }
    const paren = at + m[0].length - 1;
    const close = closing(text, paren, "()");
    const params = text.slice(paren + 1, close);
    const receiver = /^\s*&mut self\b/.test(params)
      ? "&mut self"
      : /^\s*&self\b/.test(params)
        ? "&self"
        : null;
    const semi = text.indexOf(";", close);
    const open = text.indexOf("{", close);
    const body =
      open === -1 || (semi !== -1 && semi < open)
        ? ""
        : text.slice(open, closing(text, open, "{}") + 1);
    out.push({
      name: m[1] ?? "",
      pub: /\bpub\s+$/.test(text.slice(lineStart, at)),
      attrs,
      receiver,
      body,
      near: blocks.some(([a, b]) => at > a && at < b),
      file,
    });
  }
  return out;
}

const VAULT_CONSTS = constsOf(VAULT_LIB);
const FACTORY_CONSTS = constsOf(FACTORY_LIB);
const VAULT_FNS = VAULT_FILES.flatMap(fnsOf);
const FACTORY_FNS = fnsOf(FACTORY_LIB);
const ALL_FNS = [...VAULT_FNS, ...FACTORY_FNS];

/** The contract methods a transaction calls: `pub`, in `#[near]`, `&mut self`, not init or private. */
const CALLS = ALL_FNS.filter(
  (f) =>
    f.near &&
    f.pub &&
    f.receiver === "&mut self" &&
    !f.attrs.includes("#[private]") &&
    !f.attrs.includes("#[init]"),
);

/** Every `MAX_*` constant in a set of files, private ones too. */
function maxConstsIn(files: string[]): string[] {
  return files.flatMap((f) =>
    [...code(f).matchAll(/\bconst\s+(MAX_[A-Z0-9_]*)\s*:/g)].map((m) => m[1] ?? ""),
  );
}

// --- the Rust constants ---------------------------------------------------------------------------

/** Each table that shows Rust constants: the column naming them, the column with the value, the source. */
const RUST_TABLES = [
  { id: "limits-vault", name: "name", value: "value", source: "vault" },
  { id: "limits-factory", name: "name", value: "value", source: "factory" },
  { id: "limits-gas", name: "name", value: "value", source: "either" },
  { id: "limits-formats", name: "check", value: "format", source: "vault" },
] as const;

const isConstName = (s: string) => /^[A-Z][A-Z0-9_]*$/.test(s);

/** Every Rust constant the tables show: [table, row, constant, source map]. */
function shownConsts() {
  const out: { table: string; row: RefRow; name: string; source: "vault" | "factory" }[] = [];
  for (const spec of RUST_TABLES) {
    for (const r of table(spec.id).rows) {
      const name = subject(r, spec.name);
      if (!isConstName(name)) continue;
      let source: "vault" | "factory";
      if (spec.source === "either") {
        const inVault = VAULT_CONSTS.has(name);
        const inFactory = FACTORY_CONSTS.has(name);
        expect(inVault !== inFactory, `${spec.id} ${name}: defined in exactly one lib.rs`).toBe(
          true,
        );
        source = inVault ? "vault" : "factory";
        expect(cell(r, spec.name), `${spec.id} ${name}: says which contract`).toMatch(
          new RegExp(`, ${source}$`),
        );
      } else source = spec.source;
      out.push({ table: spec.id, row: r, name, source });
    }
  }
  return out;
}

describe("limits: the Rust constants", () => {
  it("shows each constant with the value the source computes", () => {
    const shown = shownConsts();
    expect(shown.length).toBeGreaterThan(10);
    for (const s of shown) {
      const scope = s.source === "vault" ? VAULT_CONSTS : FACTORY_CONSTS;
      const c = scope.get(s.name);
      expect(
        c,
        `${s.table}: ${s.name} is not a constant of the ${s.source}'s lib.rs`,
      ).toBeDefined();
      if (!c) continue;
      const spec = RUST_TABLES.find((t) => t.id === s.table);
      const text = cell(s.row, spec?.value ?? "value");
      const v = evaluate(c, scope);
      expect(
        shows(text, v),
        `${s.table} ${s.name}: ${JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))} vs "${text}"`,
      ).toBe(true);
    }
  });

  it("shows every pub const of both lib.rs files and every MAX_* constant", () => {
    const shown = shownConsts();
    const vault = new Set(shown.filter((s) => s.source === "vault").map((s) => s.name));
    const factory = new Set(shown.filter((s) => s.source === "factory").map((s) => s.name));
    const wantVault = [
      ...new Set([
        ...[...VAULT_CONSTS.values()].filter((c) => c.pub).map((c) => c.name),
        ...maxConstsIn(VAULT_FILES),
      ]),
    ];
    const wantFactory = [
      ...new Set([
        ...[...FACTORY_CONSTS.values()].filter((c) => c.pub).map((c) => c.name),
        ...maxConstsIn([FACTORY_LIB]),
      ]),
    ];
    expect(wantVault).toContain("MAX_AGENTS");
    expect(wantFactory).toContain("MAX_NOTES");
    expect(
      wantVault.filter((n) => !vault.has(n)),
      "vault constants with no row",
    ).toEqual([]);
    expect(
      wantFactory.filter((n) => !factory.has(n)),
      "factory constants with no row",
    ).toEqual([]);
  });

  it("names, for each limit, the contract methods that read it", () => {
    for (const [id, fns] of [
      ["limits-vault", VAULT_FNS],
      ["limits-factory", FACTORY_FNS],
    ] as const) {
      for (const r of table(id).rows) {
        const name = subject(r, "name");
        if (!isConstName(name)) continue;
        const readers = fns
          .filter((f) => f.near && f.pub && new RegExp(`\\b${name}\\b`).test(f.body))
          .map((f) => f.name);
        const named = ticks(cell(r, "limits"));
        expect(
          readers.filter((m) => !named.includes(m)),
          `${id} ${name}: methods that read it`,
        ).toEqual([]);
      }
    }
  });

  it("gives the factory's testnet min_deposit as contracts/deployments/testnet.json records it", () => {
    const record = JSON.parse(
      readFileSync(join(ROOT, "contracts", "deployments", "testnet.json"), "utf8"),
    ) as { factory: { min_deposit: string; versions: { index: number; mode: string }[] } };
    const min = BigInt(record.factory.min_deposit);
    const r = table("limits-factory").rows.find((x) => x.id === "limits-factory-min_deposit");
    expect(r).toBeDefined();
    if (!r) return;
    expect(shows(cell(r, "value"), { kind: "yocto", n: min }), cell(r, "value")).toBe(true);
    expect(cell(r, "value")).toMatch(/Testnet/);
    expect(FACTORY_FNS.find((f) => f.name === "required_deposit")?.body).toMatch(/min_deposit/);
    // The current version is the last one recorded. An embedded one makes a vault cost min_deposit plus its code.
    const current = record.factory.versions.at(-1);
    expect(current).toBeDefined();
    const limits = cell(r, "limits");
    if (current?.mode === "embedded") {
      expect(limits).toContain("current version is `embedded`");
      const total = min + runway.EMBEDDED_VAULT_WASM_BYTES * runway.STORAGE_BYTE_COST_YOCTO;
      expect(limits).toContain(`about ${nearDecimal(total)} NEAR`);
      expect(limits).toContain(`${thousands(runway.EMBEDDED_VAULT_WASM_BYTES)}-byte vault wasm`);
      expect(limits).toContain("`--deposit`");
      expect(
        readFileSync(join(ROOT, "packages", "cli", "src", "commands", "vault.ts"), "utf8"),
      ).toMatch(/version\.mode === "embedded"[\s\S]{0,400}pass --deposit/);
    } else {
      expect(limits, "the Testnet version is global").not.toContain(
        "current version is `embedded`",
      );
    }
  });
});

// --- formats --------------------------------------------------------------------------------------

describe("limits: string and hash formats", () => {
  const FORMATS = table("limits-formats");
  const validateFns = fnsOf(VALIDATE).filter((f) => f.pub);

  it("names every pub fn of validate.rs", () => {
    expect(validateFns.length).toBeGreaterThan(3);
    const named = FORMATS.rows.flatMap((r) => ticks(cell(r, "check")));
    expect(validateFns.map((f) => f.name).filter((n) => !named.includes(n))).toEqual([]);
  });

  it("states the lengths, ranges and literals each checking function uses", () => {
    for (const r of FORMATS.rows) {
      const check = subject(r, "check");
      if (isConstName(check)) continue; // a constant: checked with the Rust constants above
      const fn = ALL_FNS.find((f) => f.name === check && f.body !== "");
      expect(fn, `${r.id}: no fn ${check} in the contracts`).toBeDefined();
      if (!fn) continue;
      const format = cell(r, "format");
      const numbers = [
        ...[...fn.body.matchAll(/\.len\(\)\s*(?:==|<=|>=|<|>)\s*(\d+)/g)].map((m) => m[1] ?? ""),
        ...[...fn.body.matchAll(/\((\d+)\.\.=(\d+)\)/g)].flatMap((m) => [m[1] ?? "", m[2] ?? ""]),
      ];
      for (const n of numbers)
        expect(format, `${r.id}: ${check} uses ${n}`).toMatch(new RegExp(`\\b${n}\\b`));
      // A format function's string literals (prefixes) are the format itself.
      if (fn.file === VALIDATE || check === "valid_name") {
        for (const m of fn.body.matchAll(/"((?:[^"\\]|\\.)*)"/g))
          expect(format, `${r.id}: ${check} uses "${m[1]}"`).toContain(`\`${m[1]}\``);
      }
    }
  });

  it("names every mode add_version takes, and store_code's refusal of empty input", () => {
    const addVersion = FACTORY_FNS.find((f) => f.name === "add_version");
    const modes = [...(addVersion?.body ?? "").matchAll(/"(\w+)"\s*=>/g)].map((m) => m[1] ?? "");
    expect(modes.sort()).toEqual(["embedded", "global"]);
    const modeRow = FORMATS.rows.find(
      (r) => subject(r, "check") === "add_version" && ticks(cell(r, "input")).includes("mode"),
    );
    expect(modeRow, "a row for the mode of add_version").toBeDefined();
    expect(ticks(cell(modeRow ?? { cells: {} }, "format")).sort()).toEqual(modes.sort());
    expect(addVersion?.body).toMatch(/_ => fail\("InvalidInput"\)/);
    expect(cell(modeRow ?? { cells: {} }, "past")).toBe("`InvalidInput`");

    const store = FACTORY_FNS.find((f) => f.name === "store_code");
    const internal = FACTORY_FNS.find((f) => f.name === "internal_store_code");
    expect(store?.body).toMatch(/internal_store_code\(/);
    expect(internal?.body).toMatch(/is_empty\(\)\s*\{\s*fail\("InvalidInput"\)/);
    const storeRow = FORMATS.rows.find((r) => subject(r, "check") === "store_code");
    expect(storeRow, "a row for the input of store_code").toBeDefined();
    expect(cell(storeRow ?? { cells: {} }, "format")).toMatch(/^Not empty\b/);
    expect(cell(storeRow ?? { cells: {} }, "past")).toBe("`InvalidInput`");
  });

  it("states the NEAR account id rules the vault name must also meet", () => {
    // The factory parses `<name>.<factory>` as an AccountId; the CLI's NEAR_ACCOUNT_RE writes the same rules.
    expect(FACTORY_FNS.find((f) => f.name === "vault_account_id")?.body).toMatch(
      /\.parse\(\)\s*\.unwrap_or_else\(\|_\| fail\("InvalidInput"\)\)/,
    );
    const re = /NEAR_ACCOUNT_RE\s*=\s*\/(.+)\/;/.exec(
      readFileSync(join(ROOT, "packages", "cli", "src", "payee.ts"), "utf8"),
    )?.[1];
    expect(re).toBeDefined();
    const most = /\{2,(\d+)\}/.exec(re ?? "")?.[1];
    expect(most).toBeDefined();
    // `([a-z\d]+[-_])*[a-z\d]+`: a separator only between alphanumerics.
    expect(re).toContain("([a-z\\d]+[-_])*[a-z\\d]+");
    const format = cell(rowAbout(FORMATS, "check", "valid_name") ?? { cells: {} }, "format");
    expect(format).toContain(`at most ${most} characters in all`);
    expect(format).toMatch(/at the end/);
    expect(format).toMatch(/two of them in a row/);
  });

  it("matches the memo prefix that @probarion/core exports", () => {
    const rust = VAULT_CONSTS.get("WITHDRAW_MEMO_PREFIX");
    expect(rust).toBeDefined();
    if (!rust) return;
    expect(evaluate(rust, VAULT_CONSTS)).toEqual({ kind: "str", s: core.WITHDRAW_MEMO_PREFIX });
  });
});

// --- deposits and gas per call --------------------------------------------------------------------

describe("limits: deposits and gas per call", () => {
  const DEPOSITS = table("limits-deposits");
  const byId = (id: string) => DEPOSITS.rows.find((r) => r.id === id);
  const rowOf = (method: string) =>
    byId(`limits-deposit-${method}`) ?? byId(`limits-deposit-usdc-${method}`);

  /** method -> Tgas, from the CLI's printed transactions (packages/cli/src). */
  const CLI_GAS = new Map<string, string>();
  for (const f of walkFiles(join(ROOT, "packages", "cli", "src"), ".ts")) {
    if (f.endsWith(".test.ts")) continue;
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(
      /method:\s*"(\w+)",(?:(?!method:)[\s\S])*?gasTgas:\s*"([\d.]+)"/g,
    ))
      CLI_GAS.set(m[1] ?? "", m[2] ?? "");
  }

  it("has one row for each method a transaction calls, and no other", () => {
    expect(CALLS.map((f) => f.name)).toContain("create_mandate");
    expect(CALLS.map((f) => f.name)).toContain("create_vault");
    const want = new Set(CALLS.map((f) => `limits-deposit-${f.name}`));
    const tokenRows = Object.keys(GAS).map((k) => `limits-deposit-usdc-${k}`);
    expect(
      [...want].filter((id) => !byId(id)),
      "methods with no row",
    ).toEqual([]);
    const extra = DEPOSITS.rows
      .map((r) => r.id ?? "")
      .filter((id) => !want.has(id) && !tokenRows.includes(id));
    expect(extra, "rows naming no method").toEqual([]);
  });

  it("states each method's deposit and signer as its code checks them", () => {
    for (const f of CALLS) {
      const r = byId(`limits-deposit-${f.name}`);
      if (!r) continue;
      const deposit = cell(r, "deposit");
      const payable = f.attrs.includes("#[payable]");
      const oneYocto = /\brequire_one_yocto\(\)/.test(f.body);
      if (!payable) expect(deposit, `${f.name} is not payable`).toMatch(/^None\b/);
      else if (oneYocto)
        expect(deposit, `${f.name} asks 1 yocto`).toMatch(/^Exactly 1 yoctoNEAR\b/);
      else {
        expect(deposit, `${f.name} takes a deposit`).not.toMatch(/^None\b|^Exactly 1 yoctoNEAR/);
      }
      if (/InsufficientDeposit/.test(f.body))
        expect(deposit, f.name).toContain("`InsufficientDeposit`");
      if (/predecessor_account_id\(\)\)\s*\.transfer\(/.test(f.body))
        expect(deposit, `${f.name} refunds the excess`).toMatch(/refund/i);
      const signer = cell(r, "signer");
      if (/\bassert_owner\(\)/.test(f.body)) expect(signer, f.name).toMatch(/owner/i);
      else if (/\bassert_approver\(\)/.test(f.body)) expect(signer, f.name).toMatch(/approver/i);
      else if (/\bNotAgent\b/.test(f.body)) expect(signer, f.name).toMatch(/agent key/i);
      else if (/\bNotLedgerKey\b/.test(f.body)) expect(signer, f.name).toMatch(/ledger key/i);
      else expect(signer, f.name).toMatch(/^Anyone\b/);
    }
  });

  it("shows the gas the console, the CLI and the SDK prepay", () => {
    expect(CLI_GAS.size).toBeGreaterThan(5);
    for (const [method, tgas] of Object.entries(GAS)) {
      const r = rowOf(method);
      expect(r, `GAS.${method} has no row`).toBeDefined();
      if (r)
        expect(leads(cell(r, "gas"), `${tgas} Tgas`), `${method}: ${cell(r, "gas")}`).toBe(true);
    }
    for (const [method, tgas] of CLI_GAS) {
      const r = rowOf(method);
      expect(r, `the CLI's ${method} has no row`).toBeDefined();
      if (r)
        expect(
          leads(cell(r, "gas"), `${Number(tgas)} Tgas`),
          `CLI ${method}: ${cell(r, "gas")}`,
        ).toBe(true);
    }
    for (const [method, gas] of [
      ["spend", sdk.SPEND_GAS],
      ["anchor", sdk.ANCHOR_GAS],
    ] as const) {
      const r = rowOf(method);
      expect(r).toBeDefined();
      if (r) expect(leads(cell(r, "gas"), `${gas / 10n ** 12n} Tgas`), method).toBe(true);
    }
    const sent = new Set([...Object.keys(GAS), ...CLI_GAS.keys(), "spend", "anchor"]);
    for (const f of CALLS.filter((c) => !sent.has(c.name))) {
      const r = rowOf(f.name);
      if (r) expect(cell(r, "gas"), `${f.name}: no tool prepays it`).toMatch(/^Not set\b/);
    }
  });

  it("shows the deposit the console and the CLI attach", () => {
    for (const [method, yocto] of Object.entries(METHOD_DEPOSIT)) {
      const r = rowOf(method);
      expect(r, `METHOD_DEPOSIT.${method} has no row`).toBeDefined();
      if (!r) continue;
      const want = yocto === "0" ? "None" : `${yocto} yoctoNEAR`;
      expect(leads(cell(r, "attached"), want), `${method}: ${cell(r, "attached")}`).toBe(true);
    }
    // The CLI's printed calls: `oneYocto: true` or `deposit: ONE_YOCTO` is 1 yoctoNEAR, `oneYocto: false` none.
    let cliDeposits = 0;
    for (const f of walkFiles(join(ROOT, "packages", "cli", "src"), ".ts")) {
      if (f.endsWith(".test.ts")) continue;
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(
        /method:\s*"(\w+)",(?:(?!method:)[\s\S])*?(?:oneYocto:\s*(true|false)|deposit:\s*(ONE_YOCTO)\b)/g,
      )) {
        const r = rowOf(m[1] ?? "");
        expect(r, `the CLI's ${m[1]} has no row`).toBeDefined();
        if (!r) continue;
        cliDeposits++;
        const want = m[2] === "false" ? "None" : "1 yoctoNEAR";
        expect(leads(cell(r, "attached"), want), `CLI ${m[1]}: ${cell(r, "attached")}`).toBe(true);
      }
    }
    expect(cliDeposits).toBeGreaterThan(5);
    const mandate = rowOf("create_mandate");
    const cliDefault = /\.option\(\s*"--deposit <near>",\s*"[^"]*",\s*"([\d.]+)"\s*\)/.exec(
      readFileSync(join(ROOT, "packages", "cli", "src", "commands", "mandate.ts"), "utf8"),
    )?.[1];
    expect(cliDefault).toBeDefined();
    expect(cell(mandate ?? { cells: {} }, "attached")).toContain(
      `${nearDecimal(BigInt(MANDATE_STORAGE_DEPOSIT))} NEAR`,
    );
    expect(cell(mandate ?? { cells: {} }, "attached")).toContain(`${cliDefault} NEAR`);
    expect(cell(rowOf("storage_deposit") ?? { cells: {} }, "attached")).toContain(
      `${nearDecimal(BigInt(FT_STORAGE_DEPOSIT))} NEAR`,
    );
    expect(cell(rowOf("create_vault") ?? { cells: {} }, "attached")).toContain(
      `${nearDecimal(runway.MAX_CREATE_DEPOSIT_YOCTO)} NEAR`,
    );
  });

  it("names every use the console has for the USDC token calls", () => {
    // Each exported builder in lib/near/tx.ts with its doc comment: what it is for.
    const tx = readFileSync(join(WEB, "src", "lib", "near", "tx.ts"), "utf8");
    const builders = [
      ...tx.matchAll(
        /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*export function (\w+)\(((?:(?!\nexport )[\s\S])*)/g,
      ),
    ].map((m) => ({ doc: m[1] ?? "", name: m[2] ?? "", body: m[3] ?? "" }));
    for (const method of ["storage_deposit", "ft_transfer"]) {
      const signer = cell(rowOf(method) ?? { cells: {} }, "signer");
      const uses = builders.filter((b) => b.body.includes(`"${method}"`));
      expect(uses.length, `builders of ${method}`).toBeGreaterThan(0);
      for (const b of uses) {
        if (/1Click/.test(b.doc)) expect(signer, `${method} in ${b.name}`).toMatch(/1Click/);
        else if (/funds the vault/.test(b.doc))
          expect(signer, `${method} in ${b.name}`).toMatch(/fund/);
        else throw new Error(`${b.name} builds ${method}: teach the test this use`);
      }
    }
  });
});

// --- gas the contracts attach ---------------------------------------------------------------------

describe("limits: gas the contracts attach to their own calls", () => {
  const GAS_ROWS = table("limits-gas");

  /** Each `GAS_*` use: the method it pays for, and the deposit attached with it. */
  function gasUses(): Map<string, { calls: Set<string>; deposits: Set<string> }> {
    const out = new Map<string, { calls: Set<string>; deposits: Set<string> }>();
    const add = (gas: string, call: string, deposit: string) => {
      const e = out.get(gas) ?? { calls: new Set<string>(), deposits: new Set<string>() };
      e.calls.add(call);
      e.deposits.add(deposit);
      out.set(gas, e);
    };
    for (const file of [...VAULT_FILES, FACTORY_LIB]) {
      const text = code(file);
      for (const m of text.matchAll(
        /(?:with_attached_deposit\((\w+)\)\s*\.)?with_static_gas\((GAS_\w+)\)\s*\.(\w+)\(/g,
      ))
        add(m[2] ?? "", m[3] ?? "", m[1] ?? "");
      for (const m of text.matchAll(
        /function_call\(\s*"(\w+)",[^;]*?NearToken::from_yoctonear\((\d+)\),\s*(GAS_\w+)/g,
      ))
        add(m[3] ?? "", m[1] ?? "", m[2] === "0" ? "" : (m[2] ?? ""));
      for (const m of text.matchAll(/let\s+(\w+)\s*=[^;]*?with_static_gas\((GAS_\w+)\)\s*;/g)) {
        for (const call of text.matchAll(new RegExp(`\\b${m[1]}\\.(\\w+)\\(`, "g")))
          add(m[2] ?? "", call[1] ?? "", "");
      }
    }
    return out;
  }

  it("names, for each GAS_* constant, every call it pays for and the deposit with it", () => {
    const uses = gasUses();
    const gasConsts = [...VAULT_CONSTS.keys(), ...FACTORY_CONSTS.keys()].filter((n) =>
      n.startsWith("GAS_"),
    );
    expect(gasConsts.length).toBeGreaterThan(3);
    for (const name of gasConsts) {
      const use = uses.get(name);
      expect(use, `${name}: no use found; teach the test this call form`).toBeDefined();
      const r = rowAbout(GAS_ROWS, "name", name);
      expect(r, `${name} has no row`).toBeDefined();
      if (!use || !r) continue;
      const calls = ticks(cell(r, "call"));
      for (const c of use.calls) expect(calls, `${name} pays for ${c}`).toContain(c);
      // The contract methods whose own code attaches it, such as `withdraw` for GAS_FT_TRANSFER.
      for (const f of ALL_FNS.filter(
        (x) => x.near && x.pub && new RegExp(`\\b${name}\\b`).test(x.body),
      ))
        expect(calls, `${name} is attached by ${f.name}`).toContain(f.name);
      const deposits = [...use.deposits].filter((d) => d !== "");
      if (deposits.length === 0)
        expect(cell(r, "deposit"), `${name} goes with no deposit`).toMatch(/^None\b/);
      for (const d of deposits)
        expect(ticks(cell(r, "deposit")), `${name} goes with ${d}`).toContain(d);
    }
  });
});

// --- TypeScript values ----------------------------------------------------------------------------

const APP = join(WEB, "src");
const APP_DIR = join(APP, "app");

/** The app's own source, without tests and without the docs (which name the limiters to show them). */
const APP_SRC = [...walkFiles(APP, ".ts"), ...walkFiles(APP, ".tsx")].filter(
  (f) =>
    !/\.test\.tsx?$/.test(f) &&
    !f.endsWith(join("lib", "ratelimit.ts")) &&
    !f.includes(join("lib", "docs")),
);
const APP_TEXT = new Map(APP_SRC.map((f) => [f, readFileSync(f, "utf8")] as const));

/** A `route.ts` or `page.tsx` under src/app as the path a reader opens: `[vault]` is `<vault>`. */
function sitePath(file: string): string | null {
  if (!file.startsWith(APP_DIR)) return null;
  if (basename(file) !== "route.ts" && basename(file) !== "page.tsx") return null;
  const parts = relative(APP_DIR, dirname(file))
    .split(/[\\/]/)
    .filter((p) => p !== "" && p !== "." && !/^\(.*\)$/.test(p))
    .map((p) => p.replace(/^\[(.+)\]$/, "<$1>"));
  return `/${parts.join("/")}`;
}

/** The `@/...` specifier of a module under src. */
const specifier = (file: string) =>
  `@/${relative(APP, file)
    .replace(/\\/g, "/")
    .replace(/\.tsx?$/, "")}`;

/** Whether a backticked part of `text` is `path`, alone or after a method (`POST /api/...`). */
const namesPath = (text: string, path: string) =>
  ticks(text).some((t) => t === path || t.endsWith(` ${path}`));

/** A TypeScript constant expression of integer literals, `*` and `**`, as a bigint; null for any other form. */
function evalTs(expr: string): bigint | null {
  const e = expr
    .replace(/(\d)_(?=\d)/g, "$1")
    .replace(/(\d)n\b/g, "$1")
    .trim();
  if (!/^[\d\s*]+$/.test(e)) return null;
  let total = 1n;
  for (const factor of e.split(/(?<!\*)\*(?!\*)/)) {
    const pow = factor.split("**").map((x) => BigInt(x.trim()));
    let v = pow[pow.length - 1] ?? 1n;
    for (let i = pow.length - 2; i >= 0; i--) v = (pow[i] ?? 1n) ** v;
    total *= v;
  }
  return total;
}

/** Every exported `MAX_*` and `MIN_*` constant of apps/web/src/lib, read from the source. */
const LIB_CAPS = [...APP_TEXT]
  .filter(([f]) => f.startsWith(join(APP, "lib")))
  .flatMap(([file, text]) =>
    [...text.matchAll(/^export const ((?:MAX|MIN)_[A-Z0-9_]+)\s*(?::[^=]+)?=\s*([^;]+);/gm)].map(
      (m) => ({ file, name: m[1] ?? "", value: evalTs(m[2] ?? "") }),
    ),
  );

const libCap = (name: string) => {
  const found = LIB_CAPS.filter((c) => c.name === name);
  expect(found.length, `exactly one exported ${name} in apps/web/src/lib`).toBe(1);
  return found[0]?.value ?? null;
};

/**
 * Caps of apps/web/src/lib that no table shows, each with the reason. A new cap fails the test until it is given a
 * row or a reason here; a reason whose cap is gone fails too.
 */
const UNSHOWN_CAPS: Record<string, string> = {
  MAX_APPROVERS:
    "The create form's copy of the factory's MAX_APPROVERS, which the factory table shows",
  MAX_HELD_TTL_HOURS: "The create form's copy of MAX_HELD_TTL_NS, in hours",
  MAX_READ_UNITS: "The amount reader's copy of MAX_TEXT_CHARS",
  MAX_NFKC_UNITS: "Internal to the amount reader: how far NFKC may grow the text it reads",
  MAX_BLOCK_LAG_S: "The health check's own work: how stale a node it accepts",
  MAX_PROVIDERS: "The health check's own work: the probes one list may hold",
  MAX_TEXT: "A display cap: how much of a ledger string the proof page shows",
  MIN_ALLOWANCE: "The faucet key's own floor, which the operator tops up",
};

describe("limits: the hosted app's values", () => {
  it("shows every rate limiter with its limit, and marks the ones no code reads as Planned", () => {
    const RATE = table("limits-rate");
    const keys = Object.keys(LIMITS) as (keyof typeof LIMITS)[];
    for (const key of keys) {
      const r = rowAbout(RATE, "name", key);
      expect(r, `LIMITS.${key} has no row`).toBeDefined();
      if (!r) continue;
      const [max, seconds] = LIMITS[key];
      expect(cell(r, "limit"), key).toBe(`${max} in ${windowWords(seconds)}`);
      const read = [...APP_TEXT.values()].some((t) => new RegExp(`\\bLIMITS\\.${key}\\b`).test(t));
      if (read) expect(cell(r, "where"), `${key} is read`).not.toMatch(/Planned/);
      else expect(cell(r, "where"), `${key} is read nowhere`).toMatch(/^Planned\b/);
    }
    expect(RATE.rows.map((r) => subject(r, "name")).filter((n) => !(n in LIMITS))).toEqual([]);
  });

  it("names the route or page each rate limiter guards", () => {
    const RATE = table("limits-rate");
    const routes = [...APP_TEXT.keys()].filter((f) => basename(f) === "route.ts");
    let checked = 0;
    for (const key of Object.keys(LIMITS)) {
      const where = cell(rowAbout(RATE, "name", key) ?? { cells: {} }, "where");
      const readers = [...APP_TEXT].filter(([, t]) => new RegExp(`\\bLIMITS\\.${key}\\b`).test(t));
      for (const [file] of readers) {
        const path = sitePath(file);
        if (path !== null) {
          // A route or page that reads the limiter itself.
          expect(namesPath(where, path), `${key} is read by ${path}: "${where}"`).toBe(true);
          checked++;
          continue;
        }
        // A module of src/lib that reads it: the routes that import that module.
        if (!file.startsWith(join(APP, "lib"))) continue;
        const spec = specifier(file);
        const paths = routes
          .filter((rf) => (APP_TEXT.get(rf) ?? "").includes(`from "${spec}"`))
          .map((rf) => sitePath(rf) ?? "");
        if (paths.length === 0) continue;
        expect(
          paths.some((p) => namesPath(where, p)),
          `${key} is read by ${spec}, which ${paths.join(", ")} import: "${where}"`,
        ).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(15);
  });

  it("counts each rate limiter per what its bucket key names", () => {
    const RATE = table("limits-rate");
    let checked = 0;
    for (const text of APP_TEXT.values()) {
      for (const m of text.matchAll(/(["`])([^"`]*)\1\s*,\s*LIMITS\.(\w+)\b/g)) {
        const bucket = m[2] ?? "";
        const key = m[3] ?? "";
        const per = cell(rowAbout(RATE, "name", key) ?? { cells: {} }, "per");
        expect(per, `LIMITS.${key} has a row`).not.toBe("");
        if (/clientIp\(|:ip:|ipHash/.test(bucket))
          expect(per, `${key}: ${bucket}`).toMatch(/IP address/);
        if (/network/i.test(bucket)) expect(per, `${key}: ${bucket}`).toMatch(/network/);
        if (/account/i.test(bucket)) expect(per, `${key}: ${bucket}`).toMatch(/account/);
        if (/tenant_id/.test(bucket)) expect(per, `${key}: ${bucket}`).toMatch(/^Vault\b/);
        if (!bucket.includes("${")) expect(per, `${key}: one bucket`).toMatch(/together/);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("shows every runway constant of lib/near/runway.ts", () => {
    const RUNWAY = table("limits-runway");
    const values = Object.entries(runway).filter(([, v]) => typeof v === "bigint") as [
      string,
      bigint,
    ][];
    expect(values.length).toBeGreaterThan(5);
    for (const [name, v] of values) {
      const r = rowAbout(RUNWAY, "name", name);
      expect(r, `${name} has no row`).toBeDefined();
      if (!r) continue;
      const lead = name.endsWith("_YOCTO")
        ? `${nearDecimal(v)} NEAR`
        : name.endsWith("_BYTES")
          ? `${thousands(v)} bytes`
          : null;
      expect(lead, `${name}: teach the test this unit`).not.toBeNull();
      expect(leads(cell(r, "value"), lead ?? ""), `${name}: ${cell(r, "value")}`).toBe(true);
    }
    const names = values.map(([n]) => n);
    expect(RUNWAY.rows.map((r) => subject(r, "name")).filter((n) => !names.includes(n))).toEqual(
      [],
    );
  });

  it("shows every MAX_ and MIN_ cap of apps/web/src/lib, or says why not", () => {
    const CONSOLE = table("limits-console");
    const shownElsewhere = new Set(table("limits-runway").rows.map((r) => subject(r, "name")));
    expect(LIB_CAPS.map((c) => c.name)).toContain("MAX_INVOICE_BYTES");
    expect(LIB_CAPS.map((c) => c.name)).toContain("MAX_TEXT_CHARS");
    for (const c of LIB_CAPS) {
      if (shownElsewhere.has(c.name)) continue;
      const r = rowAbout(CONSOLE, "name", c.name);
      if (!r) {
        expect(
          UNSHOWN_CAPS[c.name],
          `${c.name} (${specifier(c.file)}) has no row and no reason`,
        ).toBeDefined();
        continue;
      }
      expect(UNSHOWN_CAPS[c.name], `${c.name} has a row and a reason`).toBeUndefined();
      expect(c.value, `${c.name}: teach the test this expression`).not.toBeNull();
      const unit = c.name.endsWith("_BYTES")
        ? " bytes"
        : c.name.endsWith("_MS")
          ? " ms"
          : c.name.endsWith("_UNITS")
            ? " units"
            : "";
      expect(
        leads(cell(r, "value"), `${thousands(c.value ?? 0n)}${unit}`),
        `${c.name}: ${cell(r, "value")}`,
      ).toBe(true);
    }
    const names = new Set(LIB_CAPS.map((c) => c.name));
    expect(
      Object.keys(UNSHOWN_CAPS).filter((n) => !names.has(n)),
      "reasons for caps that are gone",
    ).toEqual([]);
    // The copies the table leaves out still equal what they copy.
    const factoryMax = FACTORY_CONSTS.get("MAX_APPROVERS");
    const factoryTtl = FACTORY_CONSTS.get("MAX_HELD_TTL_NS");
    expect(libCap("MAX_APPROVERS")).toBe(
      factoryMax && (evaluate(factoryMax, FACTORY_CONSTS) as { n: bigint }).n,
    );
    expect((libCap("MAX_HELD_TTL_HOURS") ?? 0n) * 3600n * 10n ** 9n).toBe(
      factoryTtl && (evaluate(factoryTtl, FACTORY_CONSTS) as { n: bigint }).n,
    );
    expect(libCap("MAX_READ_UNITS")).toBe(libCap("MAX_TEXT_CHARS"));
  });

  it("shows the faucet's mint, the alert cap and the upload request cap", () => {
    const CONSOLE = table("limits-console");
    const faucet = /^export const FAUCET_USDC = "(\d+)";/m.exec(
      APP_TEXT.get(join(APP, "lib", "topup", "faucet.ts")) ?? "",
    )?.[1];
    expect(faucet, "FAUCET_USDC in lib/topup/faucet.ts").toBeDefined();
    expect(
      leads(
        cell(rowAbout(CONSOLE, "name", "FAUCET_USDC") ?? { cells: {} }, "value"),
        `${faucet} test USDC`,
      ),
    ).toBe(true);

    // The last migration that defines alert_subscription_create holds the cap.
    const migrations = join(WEB, "supabase", "migrations");
    const defining = readdirSync(migrations)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(migrations, f), "utf8"))
      .filter((t) => /function public\.alert_subscription_create\b/.test(t));
    const last = defining.at(-1) ?? "";
    const body = last.slice(last.search(/function public\.alert_subscription_create\b/));
    const cap = /where tenant_id = v_tenant and active\)\s*>=\s*(\d+)/.exec(body)?.[1];
    expect(cap, "the active alert cap in alert_subscription_create").toBeDefined();
    const alerts = rowAbout(CONSOLE, "name", "alert_subscription_create");
    expect(alerts, "a row for the alert cap").toBeDefined();
    expect(leads(cell(alerts ?? { cells: {} }, "value"), cap ?? "x")).toBe(true);
    expect(
      readFileSync(join(APP, "app", "console", "[vault]", "alerts", "actions.ts"), "utf8"),
    ).toContain(`already has ${cap} alerts`);

    const shown = new Set([
      ...LIB_CAPS.map((c) => c.name),
      "FAUCET_USDC",
      "alert_subscription_create",
    ]);
    expect(CONSOLE.rows.map((r) => subject(r, "name")).filter((n) => !shown.has(n))).toEqual([]);

    const route = readFileSync(
      join(WEB, "src", "app", "api", "console", "[vault]", "invoices", "route.ts"),
      "utf8",
    );
    const form = /MAX_REQUEST_BYTES\s*=\s*MAX_INVOICE_BYTES\s*\+\s*(\d+)\s*\*\s*1024/.exec(
      route,
    )?.[1];
    expect(form, "the invoices route's request cap").toBeDefined();
    expect(cell(rowAbout(CONSOLE, "name", "MAX_INVOICE_BYTES") ?? { cells: {} }, "what")).toContain(
      `${form} KiB`,
    );
  });

  it("shows the allowance of each key the vault adds to itself", () => {
    const KEYS = table("limits-keys");
    const allowance = VAULT_FNS.find((f) => f.name === "allowance");
    expect(allowance?.body).toMatch(/Allowance::limited\(/);
    expect(allowance?.body).toMatch(/InvalidInput/);
    const adders = VAULT_FNS.filter((f) => f.near && /add_access_key_allowance\(/.test(f.body));
    expect(adders.map((f) => f.name).sort()).toEqual(["add_agent", "set_ledger_key"]);
    const keysActions = readFileSync(
      join(APP, "app", "console", "[vault]", "keys", "actions.ts"),
      "utf8",
    );
    const cli = {
      add_agent: join(ROOT, "packages", "cli", "src", "commands", "agent.ts"),
      set_ledger_key: join(ROOT, "packages", "cli", "src", "commands", "ledger.ts"),
    } as const;
    const consoleDefault = {
      add_agent: ["agentAllowanceYocto", "addAgentTx"],
      set_ledger_key: ["ledgerAllowanceYocto", "setLedgerKeyTx"],
    } as const;
    for (const f of adders) {
      const name = f.name as keyof typeof cli;
      const r = KEYS.rows.find((x) => ticks(cell(x, "key")).includes(f.name));
      expect(r, `${f.name} has a row`).toBeDefined();
      if (!r) continue;
      expect(f.body, `${f.name} checks its allowance`).toMatch(/Self::allowance\(/);
      const method = /add_access_key_allowance\([\s\S]*?"(\w+)"/.exec(f.body)?.[1] ?? "";
      expect(ticks(cell(r, "calls")), `${f.name} adds a key for ${method}`).toContain(method);
      expect(cell(r, "rule")).toMatch(/above 0/);
      expect(cell(r, "rule")).toContain("`InvalidInput`");
      const [field, builder] = consoleDefault[name];
      expect(keysActions).toMatch(new RegExp(`${builder}\\([^;]*VAULT_DEFAULTS\\.${field}`));
      expect(cell(r, "allowance")).toContain(`${nearDecimal(BigInt(VAULT_DEFAULTS[field]))} NEAR`);
      expect(cell(r, "allowance")).toContain(`\`VAULT_DEFAULTS.${field}\``);
      const cliDefault = /\.option\(\s*"--allowance <near>",\s*"[^"]*",\s*"([\d.]+)"\s*\)/.exec(
        readFileSync(cli[name], "utf8"),
      )?.[1];
      expect(cliDefault, `the CLI's --allowance default for ${f.name}`).toBeDefined();
      expect(cell(r, "allowance")).toContain(`${cliDefault} NEAR`);
    }
  });

  it("shows the SDK's and core's limits: every MAX, MIN, timeout and size among their exports", () => {
    const SDK = table("limits-sdk");
    const packages = { "@probarion/core": core, "@probarion/sdk": sdk } as Record<
      string,
      Record<string, unknown>
    >;
    const isNumbers = (v: unknown): v is Record<string, number> =>
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v) &&
      Object.values(v).length > 0 &&
      Object.values(v).every((x) => typeof x === "number");
    const LIMIT_NAME = /(^|_)(MAX|MIN)(_|$)|_MS$|TIMEOUT|_SIZE$/;
    const limits = Object.values(packages).flatMap((m) =>
      Object.entries(m)
        .filter(([n, v]) => LIMIT_NAME.test(n) && (typeof v === "number" || isNumbers(v)))
        .map(([n]) => n),
    );
    expect(limits).toContain("MAX_PAGE_LIMIT");
    expect(limits).toContain("DEFAULT_NEARAI_TIMEOUTS_MS");
    const named = SDK.rows.map((r) => subject(r, "name"));
    expect(
      limits.filter((n) => !named.includes(n)),
      "limit exports with no row",
    ).toEqual([]);
    for (const r of SDK.rows) {
      const name = subject(r, "name");
      const from = subject(r, "from");
      const v = packages[from]?.[name];
      const value = cell(r, "value");
      if (isNumbers(v)) {
        const unit = name.endsWith("_MS") ? " ms" : "";
        for (const [k, n] of Object.entries(v))
          expect(value, `${name}.${k}`).toContain(`\`${k}\` ${thousands(n)}${unit}`);
        expect(ticks(value).sort(), `${name}: its keys`).toEqual(Object.keys(v).sort());
        continue;
      }
      expect(typeof v, `${name} is not a number exported by ${from}`).toBe("number");
      expect(leads(value, thousands(v as number)), `${name}: ${value}`).toBe(true);
    }
    for (const scope of [VAULT_CONSTS, FACTORY_CONSTS]) {
      const page = scope.get("MAX_PAGE");
      expect(page && evaluate(page, scope)).toEqual({ kind: "int", n: BigInt(sdk.MAX_PAGE_LIMIT) });
    }
  });
});

// --- the page -------------------------------------------------------------------------------------

describe("limits: the page", () => {
  it("shows every table of the area once, under ids the area prefixes", () => {
    const shown = [...readMdx(PAGE).matchAll(/<RefTable\s+id="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(shown.sort()).toEqual(TABLES.map((t) => t.id).sort());
    for (const t of TABLES) {
      expect(t.id).toMatch(/^limits-/);
      for (const r of t.rows) expect(r.id ?? "", `${t.id} row`).toMatch(/^limits-[a-z0-9_-]+$/);
    }
  });
});
