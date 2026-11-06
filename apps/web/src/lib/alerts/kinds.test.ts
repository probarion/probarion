import { describe, expect, it } from "vitest";
import { kindsInWords } from "./kinds";

const DEFAULT = [
  "spend_held",
  "refused_by_contract",
  "spend_paid",
  "spend_burned",
  "spend_failed",
  "allowance_low",
  "near_low",
];

describe("kindsInWords", () => {
  it("says each kind of the default set in plain words, never as an id", () => {
    const text = kindsInWords(DEFAULT);
    expect(text).toBe(
      "a spend waits for approval, the contract refuses a spend, a spend is paid, a payout goes out to Base, a payout fails, an agent or ledger key's gas allowance runs low and the vault's free NEAR runs low",
    );
    expect(text).not.toMatch(/_/);
  });

  it("keeps a fixed order whatever order the kinds come in, and counts each once", () => {
    expect(kindsInWords(["near_low", "spend_held", "near_low"])).toBe(
      "a spend waits for approval and the vault's free NEAR runs low",
    );
  });

  it("handles one kind, none, and a kind it has no words for", () => {
    expect(kindsInWords(["spend_paid"])).toBe("a spend is paid");
    expect(kindsInWords([])).toBe("");
    expect(kindsInWords(["spend_paid", "something_new"])).toBe("a spend is paid and something_new");
  });
});
