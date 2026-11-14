import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAINNET_RECORD } from "@/components/usage/evidence";
import { REHEARSAL } from "@/lib/canary/rehearsal";
import {
  readmeRow,
  readmeSource,
  TESTED,
  TESTED_AS_OF,
  TESTED_COMMIT,
  type TestedRow,
} from "./tested";

// The table of "Tested, in numbers" is one list (tested.ts), written out three times: the README's table, JUDGES.md's
// block and the card on /usage. This holds the two Markdown files to the list, and each figure this repository can
// derive to its file. The CI counts cannot be derived here: each of those rows names its run, and its date.

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const README = read("README.md");
const JUDGES = read("JUDGES.md");
const ROWS: readonly TestedRow[] = TESTED.rows;
const row = (what: string) => {
  const r = ROWS.find((x) => x.what === what);
  if (!r) throw new Error(`no row ${what}`);
  return r;
};

/** Every string of the table, for the copy rules. */
const ALL = [
  TESTED.title,
  TESTED.cardTitle,
  TESTED.lede,
  TESTED.judges,
  ...ROWS.flatMap((r) => [r.what, r.figure, r.at, ...r.sources.map((s) => s.label)]),
];

/** "N Word tests: a, b, c." as check-claims' factSums reads it: the total, and the parts. */
function sum(figure: string): { total: number; parts: number[] } | null {
  const m = /\b([\d,]+) ([A-Z]\w*) tests: ([^.]*)\./.exec(figure);
  if (!m) return null;
  const n = (s: string) => Number(s.replaceAll(",", ""));
  const parts = [...(m[3] ?? "").matchAll(/(?<![\w.@/-])(\d{1,3}(?:,\d{3})+|\d+)(?![\w.,]\d)/g)];
  return { total: n(m[1] ?? ""), parts: parts.map((p) => n(p[1] ?? "")) };
}

describe("the README's table", () => {
  it("is under its own heading near the top, before the Contents, with the lede", () => {
    const at = README.indexOf(`\n## ${TESTED.title}\n`);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(README.indexOf("\n## Contents\n"));
    expect(flat(README)).toContain(TESTED.lede);
    // The link bar at the top names it.
    expect(README).toContain("**[Tested, in numbers](#tested-in-numbers)**");
  });

  it("is these rows, cell by cell and in this order, and nothing else", () => {
    const start = README.indexOf(
      "| What | Figure | Read at | Source |\n| --- | --- | --- | --- |\n",
    );
    expect(start).toBeGreaterThan(0);
    const lines = README.slice(start).split("\n").slice(2);
    const table = lines.slice(0, lines.indexOf(""));
    expect(table).toEqual(ROWS.map(readmeRow));
  });

  it("links a file by its path from the root, a CI log as given, and a page of the site with its source named", () => {
    expect(readmeSource({ label: "a", href: "docs/x.md" })).toBe("[a](docs/x.md)");
    expect(readmeSource({ label: "a", href: "docs/x.md" }, "../")).toBe("[a](../docs/x.md)");
    expect(readmeSource({ label: "a", href: "https://github.com/x" })).toBe(
      "[a](https://github.com/x)",
    );
    expect(readmeSource({ label: "a", href: "/canary" })).toBe(
      "[a](https://probarion.xyz/canary?via=readme)",
    );
  });
});

describe("the other places that show it", () => {
  it("gives JUDGES.md its short block, under its own heading, with the link to the table", () => {
    expect(JUDGES).toContain(`\n## ${TESTED.title}\n`);
    expect(flat(JUDGES)).toContain(TESTED.judges);
    expect(JUDGES).toContain("(README.md#tested-in-numbers)");
  });

  it("is pointed to from docs/TRACKS.md", () => {
    expect(read("docs", "TRACKS.md")).toContain(
      "[Tested, in numbers](../README.md#tested-in-numbers)",
    );
  });

  it("says in JUDGES.md only figures that the table has", () => {
    for (const figure of ["13,450", "0/20, 0.00 USDC", "Node v22.23.4", "Node v24.22.2"]) {
      expect(TESTED.judges).toContain(figure);
      expect(ROWS.some((r) => r.figure.includes(figure))).toBe(true);
    }
    expect(TESTED.judges).toContain(`\`${TESTED_COMMIT}\` on ${TESTED_AS_OF}`);
  });
});

describe("every figure is dated and sourced", () => {
  it("names, on each row, the commit, the run or the day it was read", () => {
    for (const r of ROWS) {
      expect(r.at, r.what).toMatch(/\d{4}-\d{2}-\d{2}|the same run|`[0-9a-f]{7}`/);
      expect(r.sources.length, r.what).toBeGreaterThan(0);
    }
    // The test counts come from one CI run of one commit, and the first row says which.
    expect(ROWS[0]?.at).toContain(`\`${TESTED_COMMIT}\``);
    expect(ROWS[0]?.at).toContain(TESTED_AS_OF);
  });

  it("points at files that exist, and at CI runs of this repository", () => {
    for (const s of ROWS.flatMap((r) => r.sources)) {
      if (s.href.startsWith("https://")) {
        expect(s.href).toMatch(
          /^https:\/\/github\.com\/probarion\/probarion\/actions\/runs\/\d+(\/job\/\d+)?$/,
        );
      } else if (!s.href.startsWith("/")) {
        expect(existsSync(join(ROOT, s.href)), s.href).toBe(true);
      }
    }
  });

  it("adds up: the totals of every suite, of the TypeScript suites and of the contract tests", () => {
    const all = sum(row("Automated tests, every suite").figure);
    const ts = sum(row("TypeScript tests, by suite").figure);
    const rust = sum(row("Contract tests").figure);
    for (const s of [all, ts, rust]) {
      expect(s).not.toBeNull();
      expect(s?.parts.reduce((a, x) => a + x, 0)).toBe(s?.total);
    }
    expect(all?.parts[0]).toBe(ts?.total);
    expect(all?.parts[1]).toBe(rust?.total);
    expect(row("Sandbox integration tests").figure).toMatch(/^18 passed/);
    expect(all?.parts[2]).toBe(18);
  });

  it("keeps the copy rules: no dash, no claim word, and Node named by its exact version", () => {
    for (const t of ALL) {
      expect(t, t).not.toMatch(/[\u2013\u2014]/);
      expect(t, t).not.toMatch(/\b(first|only|never|unhackable|unbreakable|guaranteed?)\b/i);
      expect(t, t).not.toMatch(/\bNode(?:\.js)? \d/);
    }
  });
});

describe("the figures this repository can derive", () => {
  it("the eval: the adversary run's summary, and the rules-only run's code layer", () => {
    const eval_ = JSON.parse(read("eval", "results", "latest.json"));
    const a = eval_.adversary.summary;
    expect(a).toMatchObject({
      cases: 20,
      wrong_proposals: "14/20",
      model_fooled: "6/6",
      decisions_paying_wrongly: "0/20",
      money_moved_wrongly: "0/20",
      usdc_moved_wrongly: "0.00",
    });
    const f = row("Eval, 20 synthetic invoices, 6 of them prompt-injected").figure;
    expect(f).toContain("6/6 injections, by construction");
    expect(f).toContain("14 of 20 proposals are wrong");
    expect(f).toContain("money moved wrongly 0/20, 0.00 USDC");
    expect(f).toContain("an offline run that asks no model");
    const md = flat(read("eval", "results", "latest.md"));
    expect(md).toContain("the code layer on its own stops 8/8 of the cases that must not be paid");
    expect(md).toContain("with 0/20 false refusals");
    expect(f).toContain("the code layer stops 8/8");
    expect(read("apps", "web", "test", "eval", "adversary.test.ts")).toContain(
      "toBeGreaterThan(5_000)",
    );
    expect(f).toContain("over 5,000 attested pay proposals");
  });

  it("the code hashes the reproducible builds match", () => {
    const hashes = JSON.parse(read("contracts", "code-hashes.json")).entries as {
      crate: string;
      code_hash: string;
    }[];
    const f = row("CI checks").figure;
    for (const [crate, short] of [
      ["probarion-vault", "3cQXYDvf"],
      ["probarion-factory", "FK6mMqUd"],
    ] as const) {
      expect(hashes.filter((h) => h.code_hash.startsWith(short)).map((h) => h.crate)).toEqual([
        crate,
      ]);
      expect(f).toContain(`\`${short}…\``);
    }
  });

  it("the vault's error codes, and its property tests' cases and operations", () => {
    const errors = read("contracts", "vault", "src", "errors.rs");
    const n = Number(/pub const ALL: \[ErrorCode; (\d+)\]/.exec(errors)?.[1]);
    expect(n).toBe(24);
    const f = row("Contract tests").figure;
    expect(f).toContain(`Each of the vault's ${n} error codes has a unit test`);
    expect(read("contracts", "vault", "tests", "error_coverage.rs")).toContain(
      "fn every_error_code_has_a_unit_test",
    );
    const inv = read("contracts", "vault", "tests", "invariants.rs");
    expect(inv).toContain("ProptestConfig::with_cases(256)");
    expect(inv.match(/vec\(op\(\), 1\.\.40\)/g)).toHaveLength(2);
    expect(f).toContain(
      "The 2 property tests run 256 random cases each, of 1 to 39 random operations",
    );
  });

  it("the sandbox tests of each file", () => {
    const dir = join(ROOT, "contracts", "integration-tests", "tests");
    const counts = Object.fromEntries(
      readdirSync(dir)
        .filter((f) => f.endsWith(".rs"))
        .map((f) => [
          f.replace(/\.rs$/, ""),
          (readFileSync(join(dir, f), "utf8").match(/#\[tokio::test\]/g) ?? []).length,
        ]),
    );
    expect(counts).toEqual({ factory: 4, flows: 2, ihitl: 1, keys: 4, security: 7 });
    expect(row("Sandbox integration tests").figure).toContain(
      "factory 4, flows 2, I-HITL 1, keys 4, security 7",
    );
  });

  it("the threat model's attacks", () => {
    const tm = read("docs", "THREAT_MODEL.md");
    const body = tm.slice(
      tm.indexOf("\n## Attacks\n"),
      tm.indexOf("\n## ", tm.indexOf("\n## Attacks\n") + 1),
    );
    const rows = body.split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l));
    expect(row("Claim checker").figure).toContain(`the threat model (${rows.length} attacks)`);
    expect(rows).toHaveLength(11);
  });

  it("the mainnet record, as the committed evidence builds it for /usage", () => {
    const f = row("Real USDC on mainnet, vault `v0.probarion.near`").figure;
    expect(MAINNET_RECORD.payments).toBe(3);
    expect(MAINNET_RECORD.basePayouts).toBe(2);
    expect(MAINNET_RECORD.refusedOnChain).toBe(1);
    expect(MAINNET_RECORD.decisions).toHaveLength(3);
    expect(f).toContain("3 test payments to the owner's own accounts");
    expect(f).toContain("1 spend refused on chain (`NoMandate`)");
    expect(f).toContain("3 attested decisions pass A1 to A8 offline");
    expect(f).toContain("the TEE measurement is not pinned");
    expect(
      read("docs", "evidence", "mainnet-v0", "s2-2026-11-13", "verify-online-2026-11-13.txt"),
    ).toMatch(/O1/);
  });

  it("the testnet refusals, the 402 run and the Canary's rehearsal, as recorded", () => {
    const testnet = JSON.parse(read("contracts", "deployments", "testnet.json"));
    expect(testnet.smoke.no_mandate_tx).toBeTruthy();
    expect(testnet.direct_refusal.date).toBe("2026-11-09");
    expect(REHEARSAL.date).toBe("2026-11-10");
    expect(REHEARSAL.contractCode).toBe("OverPerPayment");
    const runs = row("Testnet runs with a person and a model").figure;
    expect(runs).toContain("`OverPerPayment` on 2026-11-09");
    expect(runs).toContain("the Canary's `OverPerPayment` on 2026-11-10");
    const p402 = flat(read("docs", "evidence", "402-vault", "README.md"));
    expect(p402).toContain("Spends 1 to 20 paid 0.01 USDC each");
    expect(p402).toContain("rule `mandate.uses_exhausted`");
    expect(p402).toContain("answered `UsesExhausted`");
    expect(row("Pay per call (HTTP 402)").figure).toContain(
      "20 calls paid 0.01 test USDC each, and the 21st was refused by code (`mandate.uses_exhausted`)",
    );
  });
});
