import type { DecisionInput } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { NUMBER_DUPLICATE_RULE, numberDuplicateRule } from "./number-duplicate";
import type { NumberMatch } from "./store";

const EARLIER = "a".repeat(64);
const PAYEE = { type: "near", account_id: "vendor.near" } as const;
const match = (over: Partial<NumberMatch> = {}): NumberMatch => ({
  id: "0b6f1c1e-0000-4000-8000-000000000001",
  invoice_hash: EARLIER,
  status: "decided",
  outcome_status: "paid",
  ...over,
});
const check = (m: NumberMatch) => numberDuplicateRule(m, PAYEE).check({} as DecisionInput, null);

describe("numberDuplicateRule", () => {
  it("refuses, naming the payee and the earlier invoice by its hash, never by its number", () => {
    const rule = numberDuplicateRule(match(), PAYEE);
    expect(rule.id).toBe(NUMBER_DUPLICATE_RULE);
    expect(NUMBER_DUPLICATE_RULE).toBe("custom.invoice_number_duplicate");
    expect(check(match())).toEqual({
      id: NUMBER_DUPLICATE_RULE,
      outcome: "refuse",
      detail: `another invoice to near:vendor.near has the same invoice number: invoice ${EARLIER}, which was paid. Nothing is sent.`,
    });
  });

  it.each([
    [{ status: "decided", outcome_status: "paid" }, "was paid"],
    [{ status: "decided", outcome_status: "burned" }, "was paid"],
    [{ status: "decided", outcome_status: "settled" }, "was paid"],
    [{ status: "decided", outcome_status: "held" }, "is held for approval"],
    [{ status: "unconfirmed", outcome_status: "unconfirmed" }, "was sent, confirmation pending"],
    [{ status: "awaiting_owner", outcome_status: "held" }, "waits for the owner"],
    [{ status: "processing", outcome_status: null }, "is being processed"],
  ] as const)("words an earlier invoice %j as %j", (state, words) => {
    expect(check(match(state)).detail).toContain(`, which ${words}. Nothing is sent.`);
  });
});
