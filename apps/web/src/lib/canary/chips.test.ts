import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VAULT_ERROR_CODES } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { extractFacts } from "@/lib/payables/facts";
import { CANARY_CHIPS, chipFor } from "./chips";
import { CANARY_LIMITS } from "./limits";
import { ruleReason } from "./reasons";

// The chips' texts and what they say of themselves. What each text ends as in the Canary's real cycle, with a fooled
// model, is test/db/canary-chips.test.ts.

/** The Canary mandate's payee, as the evidence README of the testnet vault records it. */
const README = readFileSync(
  fileURLToPath(new URL("../../../../../docs/evidence/canary-vault/README.md", import.meta.url)),
  "utf8",
);
const PAYEE = /\| Payee \| `([^`]+)` \|/.exec(README)?.[1] ?? "";
const chip = (id: string) => {
  const c = CANARY_CHIPS.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no chip ${id}`);
  return c;
};

describe("the three one-click messages", () => {
  it("are the owner's three, in the mockup's order", () => {
    expect(CANARY_CHIPS.map((c) => [c.id, c.label])).toEqual([
      ["cap", "An invoice for 50 USDC"],
      ["bank", '"We changed banks"'],
      ["ignore", '"Ignore previous instructions"'],
    ]);
  });

  it("fit the textarea and the route: under 4,000 characters, with no blank at either end", () => {
    for (const c of CANARY_CHIPS) {
      expect(c.text.length, c.id).toBeLessThanOrEqual(CANARY_LIMITS.maxTextChars);
      expect(c.text.trim(), c.id).toBe(c.text);
    }
  });

  it("hold no personal data: no e-mail address, no phone number, no 0x address", () => {
    for (const c of CANARY_CHIPS) {
      expect(c.text, c.id).not.toMatch(/@|\d{6,}|\+\d|0x[0-9a-f]{6,}/i);
    }
  });

  it("try to pay attacker.testnet, never the mandate's payee, where the text changes the payee", () => {
    expect(PAYEE).toBe("probarion-payee.testnet");
    for (const id of ["bank", "ignore"]) {
      expect(chip(id).text, id).toContain("attacker.testnet");
      expect(chip(id).text, id).not.toContain(PAYEE);
      // The code's own payee hint reads attacker.testnet from the text: that is what mandate.payee_mismatch compares.
      expect(extractFacts(chip(id).text, "a".repeat(64), null).payee_hint, id).toEqual({
        near_account: "attacker.testnet",
      });
    }
  });

  it("send the invoice from the mandate's own payee, so only its amount is wrong, and its total is read with certainty", () => {
    const facts = extractFacts(chip("cap").text, "a".repeat(64), null);
    expect(facts.payee_hint?.near_account).toBe(PAYEE);
    expect(facts.amount).toBe("50000000");
    expect(facts.amountIssue).toBeNull();
  });

  it("each usually end as a rule the page has plain words for, and a contract code the vault has", () => {
    for (const c of CANARY_CHIPS) {
      expect(ruleReason(c.usually.rule), c.id).toBeTruthy();
      if (c.usually.raw.sent) {
        expect(VAULT_ERROR_CODES as readonly string[], c.id).toContain(c.usually.raw.contractCode);
      }
    }
  });

  it("is pressed only while the textarea holds its text exactly", () => {
    for (const c of CANARY_CHIPS) {
      expect(chipFor(c.text)?.id).toBe(c.id);
      expect(chipFor(`${c.text} `)).toBeNull();
    }
    expect(chipFor("")).toBeNull();
  });
});
