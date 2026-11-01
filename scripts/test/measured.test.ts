import { describe, expect, it } from "vitest";
import { fillMeasured, lookup } from "../lib/measured.js";

const sources = {
  proof: {
    txs: { first_near_payment: { hash: "H1" } },
    metrics: { zero: 0, ok: true, nan: Number.NaN, empty: "", nul: null, obj: { x: 1 } },
  },
  eval: {
    runs: {
      "rules-only": { summary: { exact: 57 }, cases_by_id: { "D-05": { verdict: "allow" } } },
    },
  },
};

describe("lookup", () => {
  it("reads strings, numbers (including zero) and booleans", () => {
    expect(lookup(sources, "proof.txs.first_near_payment.hash")).toBe("H1");
    expect(lookup(sources, "proof.metrics.zero")).toBe("0");
    expect(lookup(sources, "proof.metrics.ok")).toBe("true");
    expect(lookup(sources, "eval.runs.rules-only.summary.exact")).toBe("57");
    expect(lookup(sources, "eval.runs.rules-only.cases_by_id.D-05.verdict")).toBe("allow");
  });
  it("returns null for missing, null, empty, NaN and non-scalar values", () => {
    for (const path of [
      "proof.metrics.nan",
      "proof.metrics.empty",
      "proof.metrics.nul",
      "proof.metrics.obj",
      "proof.metrics.missing",
      "proof.txs.nope.hash",
      "nosuch.root",
    ]) {
      expect(lookup(sources, path)).toBeNull();
    }
  });
});

describe("fillMeasured", () => {
  it("fills known tokens, leaves unknown tokens verbatim and lists them once", () => {
    const r = fillMeasured(
      "tx {{MEASURED:proof.txs.first_near_payment.hash}} exact {{MEASURED:eval.runs.rules-only.summary.exact}} " +
        "missing {{MEASURED:proof.metrics.nan}} again {{MEASURED:proof.metrics.nan}}",
      sources,
    );
    expect(r.text).toBe(
      "tx H1 exact 57 missing {{MEASURED:proof.metrics.nan}} again {{MEASURED:proof.metrics.nan}}",
    );
    expect(r.resolved).toBe(2);
    expect(r.unresolved).toEqual(["proof.metrics.nan"]);
  });
  it("never prints undefined, null or NaN", () => {
    const r = fillMeasured(
      "{{MEASURED:proof.metrics.nul}} {{MEASURED:proof.metrics.nan}} {{MEASURED:proof.none}}",
      sources,
    );
    expect(r.text).not.toMatch(/undefined|null|NaN/);
  });
});
