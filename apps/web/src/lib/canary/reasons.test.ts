import { describe, expect, it } from "vitest";
import { TABLES } from "@/lib/docs/ref/policy";
import { RULE_REASONS, ruleReason } from "./reasons";
import { CANARY_NO_AUTOPAY_ID } from "./rules";

// The plain reasons the Canary shows for a refusal, held to the policy reference (lib/docs/ref/policy.ts), which
// test/docs-ref-policy.test.ts holds to the code: a rule added, renamed or removed there fails here until its line is.

/** The rule id of a reference row: the first `code` in its Rule id cell. */
const ruleOf = (cell: string): string => /`([^`]+)`/.exec(cell)?.[1] ?? "";
const ROWS = TABLES.flatMap((t) =>
  t.rows.map((r) => ({ rule: ruleOf(r.cells.rule ?? ""), effect: r.cells.effect ?? "" })),
);
/** `custom.<name>` is the reference's row for a caller's own rule: a pattern, not an id. */
const TEMPLATE = "custom.<name>";

describe("the plain reason of each rule", () => {
  it("reads the reference's rows: every one has a rule id and an effect", () => {
    expect(ROWS.length).toBeGreaterThan(20);
    for (const r of ROWS) {
      expect(r.rule).not.toBe("");
      expect(["Refuse", "Hold", "Hold or refuse", "Note"]).toContain(r.effect);
    }
  });

  it("covers every rule of the reference that refuses or holds, and nothing else", () => {
    const stopping = new Set(
      ROWS.filter((r) => r.effect !== "Note" && r.rule !== TEMPLATE).map((r) => r.rule),
    );
    expect(new Set(Object.keys(RULE_REASONS))).toEqual(stopping);
  });

  it("covers the rules the Canary's cycle can stop on: its own rule and the built-in caps and payee check", () => {
    for (const id of [
      CANARY_NO_AUTOPAY_ID,
      "mandate.payee_mismatch",
      "invoice.amount_invalid",
      "mandate.over_per_payment",
      "mandate.over_total",
      "vault.daily_backstop",
      "ledger.unresolved",
    ]) {
      expect(ruleReason(id), id).toBeTruthy();
    }
  });

  it("is one plain clause each, with no stop of its own: no line break, no markup, no dash, at most 110 characters", () => {
    for (const [id, line] of Object.entries(RULE_REASONS)) {
      // The page adds " (<id>)." after it.
      expect(line, id).toMatch(/^[A-Z][^\n`<>]*[^.\s]$/);
      expect(line.length, id).toBeLessThanOrEqual(110);
      expect(line, id).not.toMatch(/[–—]/);
      // The id is shown beside the line, so the line does not repeat it.
      expect(line, id).not.toContain(id);
    }
  });

  it("has no words for an id it does not know, nor for a key every object has", () => {
    expect(ruleReason("custom.other")).toBeNull();
    expect(ruleReason("toString")).toBeNull();
    expect(ruleReason("__proto__")).toBeNull();
    expect(ruleReason("")).toBeNull();
  });
});
