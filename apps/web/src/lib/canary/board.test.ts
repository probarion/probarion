import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBoard, parseFeed, refusedOnChain } from "./board";
import { isRecord, plural, thousands, usdcFromUnits, utcMinute } from "./format";

const board = (over: Record<string, unknown> = {}) => ({
  browsers: 9,
  addresses: 4,
  attempts_external: 31,
  attempts_team: 3,
  raw_external: 12,
  techniques: [
    {
      technique: "payee_change",
      attempts: 10,
      refused_by_code: 10,
      refused_by_contract: 5,
      held: 0,
    },
    { technique: "roleplay", attempts: 4, refused_by_code: 4, refused_by_contract: 0, held: 1 },
  ],
  contract_codes: [
    { code: "NoMandate", n: 4 },
    { code: "OverPerPayment", n: 1 },
  ],
  ...over,
});

describe("parseBoard", () => {
  it("reads the leaderboard the database gives and counts visitors as the smaller of browsers and addresses", () => {
    expect(parseBoard(board())).toEqual({ ...board(), visitors: 4 });
    expect(parseBoard(board({ browsers: 2, addresses: 40 }))?.visitors).toBe(2);
    expect(parseBoard(board({ browsers: 0, addresses: 0 }))?.visitors).toBe(0);
  });

  it("sums what the contract refused from its codes, and does not count the raw spends it was not asked about", () => {
    const parsed = parseBoard(board());
    expect(parsed && refusedOnChain(parsed)).toBe(5);
    expect(parsed?.raw_external).toBe(12);
  });

  it("refuses anything that is not an object", () => {
    for (const bad of [null, undefined, 3, "x", [], [board()]]) expect(parseBoard(bad)).toBeNull();
  });

  it("refuses a negative, fractional, NaN, infinite or non-numeric count", () => {
    for (const key of [
      "browsers",
      "addresses",
      "attempts_external",
      "attempts_team",
      "raw_external",
    ]) {
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "7", null]) {
        expect(parseBoard(board({ [key]: bad })), `${key}=${String(bad)}`).toBeNull();
      }
    }
  });

  it("refuses a missing count or a missing list", () => {
    for (const key of Object.keys(board())) {
      const rest: Record<string, unknown> = { ...board() };
      delete rest[key];
      expect(parseBoard(rest), key).toBeNull();
    }
  });

  it("refuses a list that is not a list, and a malformed row in it", () => {
    expect(parseBoard(board({ techniques: {} }))).toBeNull();
    expect(parseBoard(board({ contract_codes: "NoMandate" }))).toBeNull();
    const row = board().techniques[0];
    for (const bad of [
      { ...row, technique: "" },
      { ...row, technique: 5 },
      { ...row, attempts: -2 },
      { ...row, refused_by_code: Number.NaN },
      { ...row, refused_by_contract: "3" },
      { ...row, held: undefined },
      "payee_change",
      null,
    ]) {
      expect(parseBoard(board({ techniques: [row, bad] })), JSON.stringify(bad)).toBeNull();
    }
    for (const bad of [
      { code: "", n: 1 },
      { code: "X", n: -1 },
      { code: 7, n: 1 },
      { code: "X" },
      null,
    ]) {
      expect(parseBoard(board({ contract_codes: [bad] })), JSON.stringify(bad)).toBeNull();
    }
  });

  it("keeps only the fields the page shows, so that an extra one from the database is not passed on", () => {
    const parsed = parseBoard(board({ secret: "x" }));
    expect(parsed).not.toHaveProperty("secret");
    expect(Object.keys(parsed ?? {}).sort()).toEqual(
      [
        "addresses",
        "attempts_external",
        "attempts_team",
        "browsers",
        "contract_codes",
        "raw_external",
        "techniques",
        "visitors",
      ].sort(),
    );
  });

  it("accepts a board with no attempts yet", () => {
    expect(
      parseBoard({
        browsers: 0,
        addresses: 0,
        attempts_external: 0,
        attempts_team: 0,
        raw_external: 0,
        techniques: [],
        contract_codes: [],
      }),
    ).toMatchObject({ visitors: 0, techniques: [], contract_codes: [] });
  });
});

const row = (over: Record<string, unknown> = {}) => ({
  created_at: "2026-11-06T10:15:30.123456+00:00",
  techniques: ["payee_change", "fake_invoice"],
  proposal_action: "pay",
  code_status: "refused_by_code",
  code_rule: "custom.canary_no_autopay",
  raw: true,
  raw_skipped_reason: null,
  raw_detail: null,
  contract_status: "refused_by_contract",
  contract_code: "NoMandate",
  tx_hash: "AbC123",
  is_team: false,
  ...over,
});

describe("parseFeed", () => {
  it("keeps the fields the table shows, in the order the database gave them", () => {
    const out = parseFeed([
      row(),
      row({
        created_at: "2026-11-06T10:10:00Z",
        raw: false,
        contract_status: null,
        contract_code: null,
        tx_hash: null,
      }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      created_at: "2026-11-06T10:15:30.123456+00:00",
      techniques: ["payee_change", "fake_invoice"],
      code_status: "refused_by_code",
      code_rule: "custom.canary_no_autopay",
      raw: true,
      contract_status: "refused_by_contract",
      contract_code: "NoMandate",
      tx_hash: "AbC123",
      is_team: false,
    });
    expect(out[1]).toMatchObject({ raw: false, contract_status: null, tx_hash: null });
  });

  it("reads a killed attempt, which has no outcome", () => {
    expect(
      parseFeed([
        row({
          code_status: "killed",
          code_rule: null,
          contract_status: null,
          contract_code: null,
          tx_hash: null,
          raw: false,
        }),
      ]),
    ).toHaveLength(1);
  });

  it("treats an absent optional field as null", () => {
    const { code_rule: _a, contract_status: _b, contract_code: _c, tx_hash: _d, ...rest } = row();
    expect(parseFeed([rest])[0]).toMatchObject({
      code_rule: null,
      contract_status: null,
      contract_code: null,
      tx_hash: null,
    });
  });

  it("drops a row that is malformed and keeps the others", () => {
    const out = parseFeed([
      row({ tx_hash: "ok" }),
      row({ created_at: "yesterday" }),
      row({ created_at: 5 }),
      row({ techniques: "payee_change" }),
      row({ techniques: [1] }),
      row({ code_status: "" }),
      row({ code_status: null }),
      row({ raw: "yes" }),
      row({ is_team: 1 }),
      row({ tx_hash: 12 }),
      row({ code_rule: {} }),
      "garbage",
      null,
      row({ tx_hash: "also ok" }),
    ]);
    expect(out.map((r) => r.tx_hash)).toEqual(["ok", "also ok"]);
  });

  it("returns [] for anything that is not a list", () => {
    for (const bad of [null, undefined, {}, "x", 4]) expect(parseFeed(bad)).toEqual([]);
  });
});

describe("format helpers", () => {
  it("tells a plain object from everything else that typeof calls an object", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const not of [null, undefined, [], [1], "x", 3, true, () => {}])
      expect(isRecord(not)).toBe(false);
  });

  it("is the only place in the Canary code that defines isRecord or checks base units", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const components = join(here, "..", "..", "components", "canary");
    const sources = [here, components].flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
        .map((f) => join(dir, f)),
    );
    const defining = (re: RegExp) =>
      sources.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => basename(f));
    expect(defining(/(?:const|function) isRecord\b/)).toEqual(["format.ts"]);
    expect(defining(/\{1,39\}/)).toEqual(["format.ts"]);
  });

  it("turns whole base units into USDC and refuses anything else, in one place", () => {
    expect(usdcFromUnits("1500000")).toBe("1.5");
    expect(usdcFromUnits("0")).toBe("0");
    expect(usdcFromUnits("1".repeat(39))).not.toBeNull();
    for (const bad of [null, "", "12.5", "-1", "abc", "1e6", " 1", "1".repeat(40)]) {
      expect(usdcFromUnits(bad), String(bad)).toBeNull();
    }
  });

  it("groups thousands the same way everywhere", () => {
    expect(thousands(0)).toBe("0");
    expect(thousands(999)).toBe("999");
    expect(thousands(4000)).toBe("4,000");
    expect(thousands(2_000_000)).toBe("2,000,000");
  });

  it("picks the singular for exactly one", () => {
    expect(plural(1, "visitor", "visitors")).toBe("visitor");
    expect(plural(0, "visitor", "visitors")).toBe("visitors");
    expect(plural(2, "visitor", "visitors")).toBe("visitors");
  });

  it("writes a time in UTC to the minute, whatever offset it came with", () => {
    expect(utcMinute("2026-11-06T10:15:30.123456+00:00")).toBe("2026-11-06 10:15");
    expect(utcMinute("2026-11-06T17:15:30+07:00")).toBe("2026-11-06 10:15");
    expect(utcMinute("2026-11-04T12:00:00Z")).toBe("2026-11-04 12:00");
    expect(utcMinute("not a time")).toBe("not a time");
  });
});
