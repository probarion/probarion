import { describe, expect, it } from "vitest";
import { buildUsageTable, perDecision, shownSegments, USAGE_METRICS } from "./view";

const totals = [
  { segment: "team", metric: "spends_paid", value: 4 },
  { segment: "external", metric: "spends_paid", value: 3 },
  { segment: "canary", metric: "canary_attempts", value: 120 },
  { segment: "team", metric: "canary_attempts", value: 9 },
  { segment: "external", metric: "model_decisions", value: 10 },
  { segment: "external", metric: "nearai_tokens_in", value: 9000 },
  { segment: "external", metric: "nearai_tokens_out", value: 1000 },
] as const;

describe("usage view", () => {
  it("lays out every metric in three separate columns, zero-filled", () => {
    const rows = buildUsageTable([...totals]);
    expect(rows.find((r) => r.metric === "spends_paid")).toMatchObject({
      team: 4,
      external: 3,
      canary: 0,
    });
    expect(rows.find((r) => r.metric === "canary_attempts")).toMatchObject({
      team: 9,
      external: 0,
      canary: 120,
    });
    expect(rows.map((r) => r.metric)).toContain("refused_by_contract");
  });

  it("reports tokens per decision, and cost only when a price is configured", () => {
    expect(perDecision([...totals], "external", null)).toEqual({
      tokensPerDecision: 1000,
      usdPerDecision: null,
    });
    expect(
      perDecision([...totals], "external", {
        model: "m",
        inputPerMTok: 1,
        outputPerMTok: 2,
        source: "x",
      }),
    ).toEqual({
      tokensPerDecision: 1000,
      usdPerDecision: (9000 * 1 + 1000 * 2) / 1e6 / 10,
    });
    expect(perDecision([...totals], "team", null)).toEqual({
      tokensPerDecision: null,
      usdPerDecision: null,
    });
  });

  it("keeps the rows in the order of the page, with the owner's labels", () => {
    const rows = buildUsageTable([]);
    expect(rows.map((r) => [r.metric, r.label])).toEqual([
      ["vaults", "Vaults"],
      ["mandates", "Mandates signed"],
      ["spends_paid", "Payments made"],
      ["cross_chain_payouts", "of which cross-chain (Base)"],
      ["held", "Held for approval"],
      ["refused_by_code", "Refused by code"],
      ["refused_by_contract", "Refused on chain"],
      ["canary_attempts", "Canary attempts"],
      ["canary_raw_attempts", "Canary attempts sent straight to the contract"],
      ["model_decisions", "Model decisions"],
    ]);
    expect(rows.filter((r) => r.indent).map((r) => r.metric)).toEqual(["cross_chain_payouts"]);
    expect(USAGE_METRICS.map(([m]) => m)).toEqual(rows.map((r) => r.metric));
  });

  it("does not list the token counters as rows: they only feed the unit costs", () => {
    const metrics = buildUsageTable([]).map((r) => r.metric);
    expect(metrics).not.toContain("nearai_tokens_in");
    expect(metrics).not.toContain("nearai_tokens_out");
  });

  it("carries the last 7 days beside each all-time value, zero where there is none", () => {
    const recent = [
      { segment: "team", metric: "spends_paid", value: 1 },
      { segment: "canary", metric: "canary_attempts", value: "12" },
    ];
    const rows = buildUsageTable([...totals], recent);
    expect(rows.find((r) => r.metric === "spends_paid")?.week).toEqual({
      team: 1,
      external: 0,
      canary: 0,
    });
    expect(rows.find((r) => r.metric === "canary_attempts")?.week).toEqual({
      team: 0,
      external: 0,
      canary: 12,
    });
    expect(rows.find((r) => r.metric === "vaults")?.week).toEqual({
      team: 0,
      external: 0,
      canary: 0,
    });
  });

  it("without a week, every week value is zero", () => {
    for (const row of buildUsageTable([...totals])) {
      expect(row.week).toEqual({ team: 0, external: 0, canary: 0 });
    }
  });

  it("reads a numeric string (a database numeric) as the number it is, and adds a repeated row", () => {
    const rows = buildUsageTable([
      { segment: "team", metric: "held", value: "2" },
      { segment: "team", metric: "held", value: 3 },
    ]);
    expect(rows.find((r) => r.metric === "held")?.team).toBe(5);
  });

  it("gives no tokens per decision when the model decided nothing, even with tokens counted", () => {
    const only = [{ segment: "canary", metric: "nearai_tokens_in", value: 50 }];
    expect(perDecision(only, "canary", null)).toEqual({
      tokensPerDecision: null,
      usdPerDecision: null,
    });
  });

  it("gives no figure for decisions with no tokens measured: nothing measured is not zero tokens", () => {
    const t = [{ segment: "team", metric: "model_decisions", value: 30 }];
    expect(perDecision(t, "team", null)).toEqual({ tokensPerDecision: null, usdPerDecision: null });
    expect(
      perDecision(t, "team", { model: "m", inputPerMTok: 1, outputPerMTok: 2, source: "x" }),
    ).toEqual({ tokensPerDecision: null, usdPerDecision: null });
  });

  it("works each segment out of its own numbers", () => {
    const t = [
      { segment: "team", metric: "model_decisions", value: 2 },
      { segment: "team", metric: "nearai_tokens_in", value: 300 },
      { segment: "team", metric: "nearai_tokens_out", value: 100 },
      { segment: "canary", metric: "model_decisions", value: 4 },
      { segment: "canary", metric: "nearai_tokens_in", value: 700 },
      { segment: "canary", metric: "nearai_tokens_out", value: 100 },
    ];
    expect(perDecision(t, "team", null).tokensPerDecision).toBe(200);
    expect(perDecision(t, "canary", null).tokensPerDecision).toBe(200);
    expect(perDecision(t, "external", null).tokensPerDecision).toBeNull();
  });
});

describe("the segments the page shows", () => {
  const none = { external_owners: 0, canary_participants: 0, totals: [], recent: [] };

  it("is the team's alone before anyone outside has come, and with the Canary vault and its mandate set up", () => {
    expect(shownSegments(none)).toEqual(["team"]);
    expect(
      shownSegments({
        ...none,
        totals: [
          { segment: "team", metric: "canary_attempts", value: 6 },
          { segment: "external", metric: "spends_paid", value: 0 },
          { segment: "canary", metric: "vaults", value: 1 },
          { segment: "canary", metric: "mandates", value: "1" },
        ],
      }),
    ).toEqual(["team"]);
  });

  it("adds an outside segment from its first figure, all time or in the last 7 days, in the table's order", () => {
    expect(shownSegments({ ...none, external_owners: 1 })).toEqual(["team", "external"]);
    expect(shownSegments({ ...none, canary_participants: 1 })).toEqual(["team", "canary"]);
    expect(
      shownSegments({ ...none, totals: [{ segment: "external", metric: "vaults", value: "1" }] }),
    ).toEqual(["team", "external"]);
    expect(
      shownSegments({
        ...none,
        recent: [{ segment: "canary", metric: "refused_by_code", value: 2 }],
      }),
    ).toEqual(["team", "canary"]);
    expect(shownSegments({ ...none, canary_participants: 3, external_owners: 2 })).toEqual([
      "team",
      "external",
      "canary",
    ]);
  });
});
