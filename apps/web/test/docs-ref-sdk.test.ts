import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { TABLES } from "@/lib/docs/ref/sdk";
import type { RefRow, RefTable } from "@/lib/docs/ref/types";
import { ROOT, readMdx, walkFiles } from "./docs-helpers";

// The SDK reference (build/sdk-reference) against the code. Every side read here comes from
// packages/sdk itself: the runtime exports of both entry points (through the vitest aliases, which
// load packages/sdk/src), the exported types parsed from the modules each entry point re-exports,
// the public members parsed from each documented class (with the members of an object-typed field,
// such as `mandates.list`), the fields of ProbarionDeps, and the values of the constants a cell
// states. So an export, a type, a member or a field added to the SDK or taken out of it fails here,
// by name, and so does a stated value the code no longer has.

const SRC = join(ROOT, "packages", "sdk", "src");
const ENTRY = join(SRC, "index.ts");
const TESTING_ENTRY = join(SRC, "testing", "index.ts");

/** The tables that list the exports of `@probarion/sdk`, and the one for `@probarion/sdk/testing`. */
const MAIN_TABLES = [
  "sdk-client",
  "sdk-chain",
  "sdk-ledger",
  "sdk-model",
  "sdk-proof",
  "sdk-errors",
  "sdk-helpers",
];
const TESTING_TABLE = "sdk-testing";
/** The member tables, and the class whose public members each one lists (`class` column, else this). */
const MEMBER_TABLES: Readonly<Record<string, string | null>> = {
  "sdk-client-members": "Probarion",
  "sdk-chain-members": null,
  "sdk-ledger-members": null,
};
const KINDS = ["class", "function", "constant", "type"];
/**
 * The first import of the SDK transforms its whole source tree, near-api-js and viem included. It took
 * from 4 s to over 60 s while other test runs shared the machine, so both entry points load once, in a
 * hook with this much time, and the tests below only read what they export.
 */
const IMPORT_TIMEOUT_MS = 180_000;

let MAIN: Readonly<Record<string, unknown>> = {};
let TESTING: Readonly<Record<string, unknown>> = {};

beforeAll(async () => {
  // A spread copies the namespace's own enumerable keys, which are exactly its exports.
  MAIN = { ...(await import("@probarion/sdk")) };
  TESTING = { ...(await import("@probarion/sdk/testing")) };
}, IMPORT_TIMEOUT_MS);

function table(id: string): RefTable {
  const t = TABLES.find((x) => x.id === id);
  if (!t) throw new Error(`no table ${id} in src/lib/docs/ref/sdk.ts`);
  return t;
}

/** The code a cell starts with, inside its first pair of backticks. */
function leadingCode(cell: string | undefined): string {
  const code = /^`([^`]+)`/.exec((cell ?? "").trim())?.[1];
  if (code === undefined) throw new Error(`no code name in the cell "${cell}"`);
  return code;
}

/**
 * The code name a cell starts with: `Probarion` in "`Probarion`", `process` in "`process(invoice)`",
 * and `constructor` for "`new VaultClient(...)`".
 */
function codeName(cell: string | undefined): string {
  const code = leadingCode(cell);
  if (code.startsWith("new ")) return "constructor";
  const name = /^[A-Za-z_$][\w$]*/.exec(code)?.[0];
  if (name === undefined) throw new Error(`no identifier in the cell "${cell}"`);
  return name;
}

/**
 * The member path a member cell names: `process` in "`process(invoice)`", `mandates.list` in
 * "`mandates.list()`", and `constructor` for "`new VaultClient(...)`".
 */
function memberPath(cell: string | undefined): string {
  const code = leadingCode(cell);
  if (code.startsWith("new ")) return "constructor";
  const path = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(code)?.[0];
  if (path === undefined) throw new Error(`no member path in the cell "${cell}"`);
  return path;
}

/** The export rows of some tables, as `[name, kind]`. An export cell is the bare name in backticks. */
function exportRows(ids: readonly string[]): [string, string][] {
  return ids.flatMap((id) =>
    table(id).rows.map((r): [string, string] => {
      const cell = r.cells.name ?? "";
      expect(cell, `${id}: the name cell is one code name`).toMatch(/^`[A-Za-z_$][\w$]*`$/);
      return [codeName(cell), r.cells.kind ?? ""];
    }),
  );
}

const repeats = (names: readonly string[]) => names.filter((n, at) => names.indexOf(n) !== at);
const minus = (a: Iterable<string>, b: Iterable<string>) => {
  const drop = new Set(b);
  return [...new Set(a)].filter((x) => !drop.has(x)).sort();
};

/** What a runtime value is, in the reference's words. */
function kindOf(value: unknown): string {
  if (typeof value !== "function") return "constant";
  return /^class\b/.test(Function.prototype.toString.call(value)) ? "class" : "function";
}

// --- reading the SDK's source --------------------------------------------------------------------

const read = (file: string) => readFileSync(file, "utf8");

/** The names in an `export { ... }` or `export type { ... }` list, after any `as`. */
function listNames(list: string): { name: string; typeOnly: boolean }[] {
  return list
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const typeOnly = /^type\s/.test(part);
      const bare = part.replace(/^type\s+/, "");
      return { name: bare.split(/\s+as\s+/).at(-1) ?? bare, typeOnly };
    });
}

/**
 * The type names an entry point exports: every `export interface` and `export type` of the module,
 * the names of its `export type { ... }` lists and the `type` names of its `export { ... }` lists,
 * and the same for every local module it re-exports with `export * from "./x.js"`.
 */
function exportedTypes(file: string, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(file)) return out;
  seen.add(file);
  const text = read(file);
  for (const m of text.matchAll(/^export (?:interface|type) ([A-Za-z_$][\w$]*)/gm))
    out.add(m[1] ?? "");
  for (const m of text.matchAll(/^export type \{([^}]*)\}/gm)) {
    for (const n of listNames(m[1] ?? "")) out.add(n.name);
  }
  for (const m of text.matchAll(/^export \{([^}]*)\}/gm)) {
    for (const n of listNames(m[1] ?? "")) if (n.typeOnly) out.add(n.name);
  }
  for (const m of text.matchAll(/^export \* from "(\.[^"]+)\.js";/gm)) {
    for (const n of exportedTypes(join(dirname(file), `${m[1]}.ts`), seen)) out.add(n);
  }
  out.delete("");
  return out;
}

/** The lines of `export <keyword> <name>`'s body, up to its closing brace at column 0. */
function body(keyword: "class" | "interface", name: string): string[] {
  const head = new RegExp(`^export ${keyword} ${name}\\b`);
  const files = walkFiles(SRC, ".ts").filter((f) =>
    read(f)
      .split(/\r?\n/)
      .some((l) => head.test(l)),
  );
  expect(files, `export ${keyword} ${name} in packages/sdk/src`).toHaveLength(1);
  const lines = read(files[0] ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => head.test(l));
  const end = lines.findIndex((l, at) => at > start && l === "}");
  expect(end, `the end of ${keyword} ${name}`).toBeGreaterThan(start);
  return lines.slice(start + 1, end);
}

const MODIFIERS = String.raw`(?:(?:readonly|async|get|set|static|override|public)\s+)*`;
const MEMBER = new RegExp(String.raw`^ {2}${MODIFIERS}([A-Za-z_$][\w$]*)\s*[(<:=?!]`);
/** A field whose type is an object of members: `readonly mandates: {`, then the rest of its line. */
const OBJECT_FIELD = new RegExp(String.raw`^ {2}${MODIFIERS}[A-Za-z_$][\w$]*\??:\s*\{(.*)$`);
/** A member inside such an object type: at its start or after a `;`, before `(`, `<` or `:`. */
const INNER_MEMBER = /(?:^|;)\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[(<:]/g;
const COMMENT = /^\s*(?:\/\*|\*|\/\/)/;

/**
 * A class's public members: its fields, getters, methods and constructor. `private` and `#` ones are
 * left out. A field typed as an object of members stands for those members, by path: Probarion's
 * `readonly mandates: { list(): ...; get(id: number): ... }` gives `mandates.list` and `mandates.get`.
 */
function publicMembers(name: string): Set<string> {
  const out = new Set<string>();
  const lines = body("class", name);
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? "";
    if (/^ {2}(?:private|protected)\b/.test(line)) continue;
    const field = MEMBER.exec(line)?.[1];
    if (field === undefined) continue;
    const object = OBJECT_FIELD.exec(line);
    if (object === null) {
      out.add(field);
      continue;
    }
    let inner = object[1] ?? "";
    if (!/\}\s*;?\s*$/.test(inner)) {
      // The type goes on over the next lines, up to its closing brace at the first indent.
      while (++at < lines.length && !/^ {2}\}/.test(lines[at] ?? "")) {
        const next = lines[at] ?? "";
        if (!COMMENT.test(next)) inner += `;${next}`;
      }
    }
    const members = [...inner.replace(/^\s*/, ";").matchAll(INNER_MEMBER)].map((m) => m[1] ?? "");
    expect(members, `${name}.${field}: the members of its type`).not.toEqual([]);
    for (const member of members) out.add(`${field}.${member}`);
  }
  return out;
}

/** The fields of an interface, one per line at its first indent. */
function interfaceFields(name: string): Set<string> {
  const out = new Set<string>();
  for (const line of body("interface", name)) {
    const m = /^ {2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:(]/.exec(line);
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

// --- the tests -----------------------------------------------------------------------------------

describe("SDK reference: the exports", () => {
  it("lists every runtime export of @probarion/sdk, and nothing else", () => {
    const actual = Object.keys(MAIN);
    expect(actual.length, "exports of @probarion/sdk").toBeGreaterThan(0);
    const rows = exportRows(MAIN_TABLES).filter(([, kind]) => kind !== "type");
    const documented = rows.map(([name]) => name);
    expect(repeats(documented), "documented twice").toEqual([]);
    expect(minus(actual, documented), "exported by @probarion/sdk but not documented").toEqual([]);
    expect(minus(documented, actual), "documented but not exported by @probarion/sdk").toEqual([]);
  });

  it("lists every runtime export of @probarion/sdk/testing, and nothing else", () => {
    const actual = Object.keys(TESTING);
    expect(actual.length, "exports of @probarion/sdk/testing").toBeGreaterThan(0);
    const rows = exportRows([TESTING_TABLE]).filter(([, kind]) => kind !== "type");
    const documented = rows.map(([name]) => name);
    expect(repeats(documented), "documented twice").toEqual([]);
    expect(
      minus(actual, documented),
      "exported by @probarion/sdk/testing but not documented",
    ).toEqual([]);
    expect(
      minus(documented, actual),
      "documented but not exported by @probarion/sdk/testing",
    ).toEqual([]);
  });

  it("gives each runtime export the kind it has when imported", () => {
    const values: Record<string, unknown> = { ...TESTING, ...MAIN };
    const wrong: string[] = [];
    for (const [name, kind] of exportRows([...MAIN_TABLES, TESTING_TABLE])) {
      expect(KINDS, `${name}: kind "${kind}"`).toContain(kind);
      if (kind === "type") continue;
      const actual = kindOf(values[name]);
      if (actual !== kind) wrong.push(`${name}: documented as ${kind}, is a ${actual}`);
    }
    expect(wrong).toEqual([]);
  });

  it("lists every type each entry point exports, and only those", () => {
    for (const [entry, ids] of [
      [ENTRY, MAIN_TABLES],
      [TESTING_ENTRY, [TESTING_TABLE]],
    ] as const) {
      const actual = exportedTypes(entry);
      expect(actual.size, `types found from ${entry}`).toBeGreaterThan(0);
      const documented = exportRows(ids)
        .filter(([, kind]) => kind === "type")
        .map(([name]) => name);
      expect(repeats(documented), "documented twice").toEqual([]);
      expect(minus(actual, documented), `types exported from ${entry} but not documented`).toEqual(
        [],
      );
      expect(minus(documented, actual), `types documented but not exported from ${entry}`).toEqual(
        [],
      );
    }
  });

  it("finds each documented type declared or re-exported in packages/sdk/src", () => {
    const sources = walkFiles(SRC, ".ts").map(read).join("\n");
    const lists = [...sources.matchAll(/^export (?:type )?\{([^}]*)\}/gm)].flatMap((m) =>
      listNames(m[1] ?? "").map((n) => n.name),
    );
    const missing = exportRows([...MAIN_TABLES, TESTING_TABLE])
      .filter(([, kind]) => kind === "type")
      .map(([name]) => name)
      .filter(
        (name) =>
          !new RegExp(`^export (?:interface|type) ${name}\\b`, "m").test(sources) &&
          !lists.includes(name),
      );
    expect(missing).toEqual([]);
  });

  it("anchors each export row at sdk-<name>, or sdk-testing-<name>, in lowercase", () => {
    for (const id of [...MAIN_TABLES, TESTING_TABLE]) {
      const prefix = id === TESTING_TABLE ? "sdk-testing-" : "sdk-";
      for (const r of table(id).rows) {
        expect(r.id, `${id}: ${r.cells.name}`).toBe(
          `${prefix}${codeName(r.cells.name).toLowerCase()}`,
        );
      }
    }
  });
});

describe("SDK reference: the members", () => {
  it("lists the public members of each class it documents, and no other", () => {
    for (const [id, fixed] of Object.entries(MEMBER_TABLES)) {
      const byClass = new Map<string, string[]>();
      for (const r of table(id).rows) {
        const owner = fixed ?? codeName(r.cells.class);
        byClass.set(owner, [...(byClass.get(owner) ?? []), memberPath(r.cells.member)]);
      }
      for (const [owner, documented] of byClass) {
        const actual = publicMembers(owner);
        expect(actual.size, `public members of ${owner}`).toBeGreaterThan(0);
        expect(repeats(documented), `${id}: members of ${owner} documented twice`).toEqual([]);
        expect(minus(actual, documented), `${id}: members of ${owner} not documented`).toEqual([]);
        expect(
          minus(documented, actual),
          `${id}: documented members ${owner} does not have`,
        ).toEqual([]);
      }
    }
  });

  it("reads the members of Probarion's object-typed fields by path, never as a bare field", () => {
    const actual = [...publicMembers("Probarion")];
    const paths = actual.filter((m) => m.includes("."));
    expect(paths.length, "Probarion members with a path").toBeGreaterThan(0);
    const heads = new Set(paths.map((p) => p.split(".")[0] ?? ""));
    expect(actual.filter((m) => heads.has(m))).toEqual([]);
  });

  it("documents members only of classes the reference lists as exports", () => {
    const classes = new Set(
      exportRows(MAIN_TABLES)
        .filter(([, kind]) => kind === "class")
        .map(([name]) => name),
    );
    for (const [id, fixed] of Object.entries(MEMBER_TABLES)) {
      for (const r of table(id).rows) {
        const owner = fixed ?? codeName(r.cells.class);
        expect(classes.has(owner), `${id}: ${owner}`).toBe(true);
      }
    }
  });

  it("lists every field of ProbarionDeps, and no other", () => {
    const actual = interfaceFields("ProbarionDeps");
    const documented = table("sdk-deps").rows.map((r) => codeName(r.cells.field));
    expect(repeats(documented), "documented twice").toEqual([]);
    expect(minus(actual, documented), "fields of ProbarionDeps not documented").toEqual([]);
    expect(minus(documented, actual), "documented fields ProbarionDeps does not have").toEqual([]);
  });
});

// --- the values a cell states --------------------------------------------------------------------

type Exports = Readonly<Record<string, unknown>>;

/** The one row with this id, in any table of the area. */
function row(id: string): RefRow {
  const found = TABLES.flatMap((t) => t.rows).filter((r) => r.id === id);
  expect(found, `the row ${id}`).toHaveLength(1);
  const [only] = found;
  if (only === undefined) throw new Error(`no row ${id}`);
  return only;
}
const rowText = (id: string) => Object.values(row(id).cells).join(" | ");

function num(value: unknown): number {
  if (typeof value !== "number") throw new Error(`not a number: ${String(value)}`);
  return value;
}
function str(value: unknown): string {
  if (typeof value !== "string") throw new Error(`not a string: ${String(value)}`);
  return value;
}
function strs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`not a list of strings: ${String(value)}`);
  }
  return value;
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null)
    throw new Error(`not an object: ${String(value)}`);
  return value as Record<string, unknown>;
}
const code = (value: unknown) => `\`${String(value)}\``;
/** "`A`, `B` and `C`", the way a cell lists code names. */
function andList(items: readonly string[]): string {
  const coded = items.map(code);
  return coded.length < 2 ? coded.join("") : `${coded.slice(0, -1).join(", ")} and ${coded.at(-1)}`;
}
const TGAS = 10n ** 12n;
function tgas(value: unknown): string {
  if (typeof value !== "bigint" || value % TGAS !== 0n) {
    throw new Error(`not a whole number of Tgas: ${String(value)}`);
  }
  return `${value / TGAS} Tgas`;
}
function kib(value: unknown): string {
  const bytes = num(value);
  expect(bytes % 1024, `${bytes} bytes in KiB`).toBe(0);
  return `${bytes / 1024} KiB`;
}
function days(value: unknown): string {
  if (typeof value !== "bigint") throw new Error(`not nanoseconds: ${String(value)}`);
  return `${Number(value) / 86_400e9} days`;
}
function isoSeconds(value: unknown): string {
  if (typeof value !== "bigint") throw new Error(`not nanoseconds: ${String(value)}`);
  return new Date(Number(value / 1_000_000n)).toISOString().replace(/\.000Z$/, "Z");
}
/** "catalog 10 s, report 15 s, chat 90 s and signature 15 s", from the timeouts record. */
function timeouts(value: unknown): string {
  const all = record(value);
  const phases = ["catalog", "report", "chat", "signature"];
  expect(Object.keys(all).sort(), "the NEAR AI call kinds").toEqual([...phases].sort());
  const parts = phases.map((p) => `${p} ${num(all[p]) / 1000} s`);
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
/** The pre-ledger vaults: each mainnet one in backticks, and "Testnet has none" while it has none. */
function preLedgerVaults(value: unknown): string[] {
  const all = record(value);
  expect(Object.keys(all).sort(), "the networks of PRE_LEDGER_VAULTS").toEqual([
    "mainnet",
    "testnet",
  ]);
  const testnet = strs(all.testnet);
  return [...strs(all.mainnet).map(code), ...(testnet.length === 0 ? ["Testnet has none"] : [])];
}
/** The decision file pattern, as a cell writes it, once the regular expression is shown to match it. */
function decisionPattern(value: unknown): string {
  if (!(value instanceof RegExp)) throw new Error(`not a regular expression: ${String(value)}`);
  expect(value.test("v0-decision-1.json"), "a v0-decision-*.json file").toBe(true);
  expect(value.test("v0-invoice-1.txt"), "an invoice file").toBe(false);
  return "`v0-decision-*.json`";
}
/** The figure a detail message gives, as "about <n> NEAR ...", found with `pattern`. */
function about(value: unknown, pattern: RegExp): RegExpExecArray {
  const found = pattern.exec(str(value));
  if (found === null) throw new Error(`"${String(value)}" does not match ${pattern}`);
  return found;
}

/** Each row that states a constant's value, and the text that value gives, from the exports. */
const VALUE_CHECKS: readonly (readonly [
  row: string,
  text: (m: Exports, t: Exports) => string[],
])[] = [
  ["sdk-spend_gas", (m) => [tgas(m.SPEND_GAS)]],
  ["sdk-vaultclient-spend", (m) => [tgas(m.SPEND_GAS)]],
  ["sdk-anchor_gas", (m) => [tgas(m.ANCHOR_GAS)]],
  ["sdk-vaultclient-anchor", (m) => [tgas(m.ANCHOR_GAS)]],
  ["sdk-page_size", (m) => [`${num(m.PAGE_SIZE)}: `]],
  ["sdk-max_page_limit", (m) => [`${num(m.MAX_PAGE_LIMIT)}: `]],
  ["sdk-vaultclient-listmandates", (m) => [`1 to ${num(m.MAX_PAGE_LIMIT)}`]],
  ["sdk-catalog_page_size", (m) => [`${num(m.CATALOG_PAGE_SIZE)}: `]],
  ["sdk-max_response_body_bytes", (m) => [kib(m.MAX_RESPONSE_BODY_BYTES)]],
  ["sdk-nearairesponsetoolargeerror", (m) => [kib(m.MAX_RESPONSE_BODY_BYTES)]],
  ["sdk-unknown_settle_ms", (m) => [`${num(m.UNKNOWN_SETTLE_MS) / 3_600_000} hours`]],
  ["sdk-default_ledger_path", (m) => [code(str(m.DEFAULT_LEDGER_PATH))]],
  ["sdk-default_nearai_timeouts_ms", (m) => [timeouts(m.DEFAULT_NEARAI_TIMEOUTS_MS)]],
  ["sdk-accepted_tcb_statuses", (m) => [andList(strs(m.ACCEPTED_TCB_STATUSES))]],
  [
    "sdk-o1_measurement_pinned",
    (m) => {
      expect(typeof m.O1_MEASUREMENT_PINNED, "O1_MEASUREMENT_PINNED").toBe("boolean");
      return [code(m.O1_MEASUREMENT_PINNED)];
    },
  ],
  ["sdk-archival_after_ns", (m) => [days(m.ARCHIVAL_AFTER_NS)]],
  ["sdk-deps-archivalrpc", (m) => [days(m.ARCHIVAL_AFTER_NS)]],
  ["sdk-default_evidence_dir", (m) => [code(str(m.DEFAULT_EVIDENCE_DIR))]],
  ["sdk-deps-evidencedir", (m) => [code(str(m.DEFAULT_EVIDENCE_DIR))]],
  ["sdk-default_proof_file", (m) => [code(str(m.DEFAULT_PROOF_FILE))]],
  ["sdk-deps-burntxhints", (m) => [code(str(m.DEFAULT_PROOF_FILE))]],
  ["sdk-pre_ledger_vaults", (m) => preLedgerVaults(m.PRE_LEDGER_VAULTS)],
  ["sdk-deps-preledgerdecisionhashes", (m) => strs(record(m.PRE_LEDGER_VAULTS).mainnet).map(code)],
  ["sdk-pre_ledger_decision_file", (m) => [decisionPattern(m.PRE_LEDGER_DECISION_FILE)]],
  ["sdk-readpreledgerdecisionhashes", (m) => [decisionPattern(m.PRE_LEDGER_DECISION_FILE)]],
  ["sdk-lack_balance_code", (m) => [code(str(m.LACK_BALANCE_CODE))]],
  ["sdk-not_enough_balance_code", (m) => [code(str(m.NOT_ENOUGH_BALANCE_CODE))]],
  [
    "sdk-out_of_near_detail",
    (m) => [`about ${about(m.OUT_OF_NEAR_DETAIL, /about ([\d.]+) NEAR of storage/)[1]} NEAR`],
  ],
  [
    "sdk-out_of_gas_near_detail",
    (m) => {
      const [, near, gas] = about(m.OUT_OF_GAS_NEAR_DETAIL, /about ([\d.]+) NEAR at (\d+) Tgas/);
      expect(`${gas} Tgas`, "the gas the detail names").toBe(tgas(m.SPEND_GAS));
      return [`about ${near} NEAR for ${gas} Tgas`];
    },
  ],
  ["sdk-proposal_request_template", (m) => [code(str(m.PROPOSAL_REQUEST_TEMPLATE))]],
  [
    "sdk-default_archival_rpc_urls",
    (m) => {
      const all = record(m.DEFAULT_ARCHIVAL_RPC_URLS);
      expect(Object.keys(all).sort(), "the archival networks").toEqual(["mainnet", "testnet"]);
      for (const url of Object.values(all).flatMap(strs)) {
        expect(new URL(url).hostname, "an archival RPC host").toMatch(/\.fastnear\.com$/);
      }
      return ["FastNEAR", "for mainnet and for testnet"];
    },
  ],
  ["sdk-testing-scenario_vault", (_, t) => [code(str(t.SCENARIO_VAULT))]],
  ["sdk-testing-createscenariochain", (_, t) => [code(str(t.SCENARIO_VAULT))]],
  ["sdk-testing-scenario_approver", (_, t) => [code(str(t.SCENARIO_APPROVER))]],
  ["sdk-testing-scenario_near_payee", (_, t) => [code(str(t.SCENARIO_NEAR_PAYEE))]],
  ["sdk-testing-scenario_now", (_, t) => [isoSeconds(t.SCENARIO_NOW)]],
  ["sdk-testing-gas_floor_near_payout", (_, t) => [tgas(t.GAS_FLOOR_NEAR_PAYOUT)]],
  ["sdk-testing-gas_floor_intents_payout", (_, t) => [tgas(t.GAS_FLOOR_INTENTS_PAYOUT)]],
  [
    "sdk-testing-fake_nearai_base_url",
    (_, t) => {
      expect(new URL(str(t.FAKE_NEARAI_BASE_URL)).hostname, "the fake's host").toMatch(/\.test$/);
      return ["`.test` host"];
    },
  ],
  ["sdk-testing-zero_code_hash", (_, t) => [code(str(t.ZERO_CODE_HASH))]],
];

const whole = (digits: string | undefined) => Number((digits ?? "").replace(/_/g, ""));

/**
 * Each row that states a default the SDK does not export, the source file and line that set it, and
 * the text that line gives.
 */
const SOURCE_CHECKS: readonly (readonly [
  row: string,
  file: string,
  line: RegExp,
  text: (found: RegExpExecArray) => string,
])[] = [
  [
    "sdk-fileledgerstore-new",
    "ledger-store.ts",
    /^const DEFAULT_LEDGER_FILE = "([^"]+)";$/m,
    (f) => code(f[1]),
  ],
  [
    "sdk-fileledgerstore-new",
    "ledger-store.ts",
    /^ {2}constructor\(path: string = DEFAULT_LEDGER_FILE\b/m,
    () => "`path` defaults to",
  ],
  [
    "sdk-fileledgerstoreoptions",
    "ledger-store-lock.ts",
    /^export const DEFAULT_LOCK_TIMEOUT_MS = ([\d_]+);$/m,
    (f) => `${whole(f[1]) / 1000} s by default`,
  ],
  [
    "sdk-nearapijssenderoptions",
    "tx.ts",
    /^const DEFAULT_SEND_TIMEOUT_MS = ([\d_]+);$/m,
    (f) => `${whole(f[1]) / 1000} s per step by default`,
  ],
  ["sdk-rpcclientoptions", "rpc.ts", /^const MAX_ROUNDS_LIMIT = (\d+);$/m, (f) => `1 to ${f[1]}`],
  ["sdk-rpcclientoptions", "rpc.ts", /opts\.maxRounds \?\? (\d+);/, (f) => `default ${f[1]}`],
  ["sdk-pageall", "paging.ts", /^export const MAX_PAGES = (\d+);$/m, (f) => `${f[1]} pages`],
];

describe("SDK reference: the values", () => {
  it("states each constant's value as the code has it", () => {
    const wrong: string[] = [];
    for (const [id, text] of VALUE_CHECKS) {
      const cells = rowText(id);
      for (const fragment of text(MAIN, TESTING)) {
        if (!cells.includes(fragment)) wrong.push(`${id}: "${fragment}" missing from "${cells}"`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("states each default the SDK does not export as its source sets it", () => {
    const wrong: string[] = [];
    for (const [id, file, line, text] of SOURCE_CHECKS) {
      const found = line.exec(read(join(SRC, file)));
      if (found === null) {
        wrong.push(`${id}: ${line} not found in packages/sdk/src/${file}`);
        continue;
      }
      const fragment = text(found);
      const cells = rowText(id);
      if (!cells.includes(fragment)) wrong.push(`${id}: "${fragment}" missing from "${cells}"`);
    }
    expect(wrong).toEqual([]);
  });

  it("calls the pre-ledger vault Planned exactly while the mainnet record has no transaction", () => {
    const deployment = JSON.parse(read(join(ROOT, "contracts", "deployments", "mainnet.json"))) as {
      vault_v0?: { account_id?: unknown; create_tx?: unknown; deploy_tx?: unknown };
    };
    const v0 = deployment.vault_v0;
    expect(strs(record(MAIN.PRE_LEDGER_VAULTS).mainnet)).toEqual([v0?.account_id]);
    const planned = v0?.create_tx === null && v0?.deploy_tx === null;
    for (const id of ["sdk-pre_ledger_vaults", "sdk-deps-preledgerdecisionhashes"]) {
      expect(rowText(id).includes("Planned"), `${id} says Planned`).toBe(planned);
    }
    const page = readMdx("build/sdk-reference");
    expect(page.includes(`${code(v0?.account_id)}, which is Planned`), "the page").toBe(planned);
  });
});

describe("SDK reference: the page", () => {
  const page = readMdx("build/sdk-reference");

  it("shows each of the area's tables once, and no table of another id", () => {
    const shown = [...page.matchAll(/<RefTable id="([^"]+)" \/>/g)].map((m) => m[1] ?? "");
    expect(repeats(shown), "a table shown twice").toEqual([]);
    expect(shown.sort()).toEqual(TABLES.map((t) => t.id).sort());
  });

  it("shows the install line the authoring guide allows", () => {
    expect(page).toContain("```bash\nnpm install @probarion/sdk @probarion/core\n```");
  });
});
