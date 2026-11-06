import { describe, expect, it } from "vitest";
import { parseUsage } from "./parse";

const GOOD = {
  network: "mainnet",
  totals: [
    { segment: "team", metric: "vaults", value: 1 },
    { segment: "external", metric: "spends_paid", value: "12" },
    { segment: "canary", metric: "canary_attempts", value: 40 },
    { segment: "external", metric: "nearai_tokens_in", value: 9000 },
  ],
  recent: [{ segment: "canary", metric: "canary_attempts", value: 5 }],
  canary_participants: 7,
  external_owners: 3,
  team_vaults: 1,
  pilots: [
    { cohort: "external", n: 2 },
    { cohort: "team", n: 1 },
  ],
  pilot_names: ["Acme Design"],
  updated_at: "2026-11-06T10:15:30.123456+00:00",
};

const with_ = (over: Record<string, unknown>) => ({ ...GOOD, ...over });

describe("parseUsage", () => {
  it("reads a well-formed answer, with numbers as numbers and pilots per cohort", () => {
    expect(parseUsage(GOOD, "mainnet")).toEqual({
      network: "mainnet",
      totals: [
        { segment: "team", metric: "vaults", value: 1 },
        { segment: "external", metric: "spends_paid", value: 12 },
        { segment: "canary", metric: "canary_attempts", value: 40 },
        { segment: "external", metric: "nearai_tokens_in", value: 9000 },
      ],
      recent: [{ segment: "canary", metric: "canary_attempts", value: 5 }],
      canary_participants: 7,
      external_owners: 3,
      team_vaults: 1,
      pilots: { team: 1, external: 2, canary: 0 },
      pilot_names: ["Acme Design"],
      updated_at: "2026-11-06T10:15:30.123456+00:00",
    });
  });

  it("reads an empty database: no rows, no pilots, no update time", () => {
    const m = parseUsage(
      with_({ totals: [], recent: [], pilots: [], pilot_names: [], updated_at: null }),
      "mainnet",
    );
    expect(m).toMatchObject({
      totals: [],
      recent: [],
      pilots: { team: 0, external: 0, canary: 0 },
      pilot_names: [],
      updated_at: null,
    });
  });

  it("is null when it is for another network than the one asked: a testnet number must not read as mainnet", () => {
    expect(parseUsage(GOOD, "testnet")).toBeNull();
    expect(parseUsage(with_({ network: "devnet" }), "mainnet")).toBeNull();
    expect(parseUsage({ ...GOOD, network: undefined }, "mainnet")).toBeNull();
  });

  it("leaves out a row of a segment or a metric the page does not know, and keeps the rest", () => {
    const m = parseUsage(
      with_({
        totals: [
          ...GOOD.totals,
          { segment: "partner", metric: "vaults", value: 9 },
          { segment: "team", metric: "invented", value: 9 },
        ],
      }),
      "mainnet",
    );
    expect(m?.totals).toHaveLength(4);
  });

  it.each([
    ["not an object", "usage"],
    ["null", null],
    ["an array", []],
    ["no totals", with_({ totals: undefined })],
    ["totals that are not a list", with_({ totals: {} })],
    ["a row that is not an object", with_({ totals: ["x"] })],
    ["a negative value", with_({ totals: [{ segment: "team", metric: "vaults", value: -1 }] })],
    [
      "a value that is not a number",
      with_({ totals: [{ segment: "team", metric: "vaults", value: "many" }] }),
    ],
    [
      "an infinite value",
      with_({ totals: [{ segment: "team", metric: "vaults", value: Number.POSITIVE_INFINITY }] }),
    ],
    ["a missing value", with_({ totals: [{ segment: "team", metric: "vaults" }] })],
    ["recent that is not a list", with_({ recent: null })],
    ["a bad recent row", with_({ recent: [{ segment: "team", metric: "vaults", value: -2 }] })],
    ["a negative count of participants", with_({ canary_participants: -1 })],
    ["a fractional count of owners", with_({ external_owners: 1.5 })],
    ["a count that is text", with_({ team_vaults: "1" })],
    ["no count of participants", with_({ canary_participants: undefined })],
    ["pilots that are not a list", with_({ pilots: "none" })],
    ["a pilot row with a bad count", with_({ pilots: [{ cohort: "team", n: -1 }] })],
    ["a pilot name that is not text", with_({ pilot_names: [1] })],
    ["pilot names that are not a list", with_({ pilot_names: "Acme" })],
    ["an update time that is not a time", with_({ updated_at: "later" })],
    ["an update time that is a number", with_({ updated_at: 5 })],
    ["no update time field", with_({ updated_at: undefined })],
  ])("is null for %s", (_what, json) => {
    expect(parseUsage(json, "mainnet")).toBeNull();
  });

  it("ignores a pilot cohort it does not know, and adds a cohort given twice", () => {
    const m = parseUsage(
      with_({
        pilots: [
          { cohort: "team", n: 1 },
          { cohort: "team", n: 2 },
          { cohort: "alien", n: 5 },
        ],
      }),
      "mainnet",
    );
    expect(m?.pilots).toEqual({ team: 3, external: 0, canary: 0 });
  });

  it("drops a blank pilot name", () => {
    expect(parseUsage(with_({ pilot_names: ["Acme", "  ", ""] }), "mainnet")?.pilot_names).toEqual([
      "Acme",
    ]);
  });
});
