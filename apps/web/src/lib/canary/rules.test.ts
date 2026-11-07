import { type DecisionInput, decide, type MandateView } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { CANARY_NO_AUTOPAY_ID, canaryNoAutopay } from "./rules";

const H = (c: string) => c.repeat(64);
const AGENT = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

const mandate: MandateView = {
  id: 1,
  payee: { type: "near", account_id: "canary-payee.near" },
  purpose_hash: H("a"),
  max_per_payment: "5000000",
  max_total: "100000000",
  spent: "0",
  reserved: "0",
  max_uses: 100,
  uses: 0,
  expires_at_ns: "4102444800000000000",
  approval_above: "1000000",
  agent_pk: AGENT,
  label: "canary",
  status: "active",
  created_at_ns: "1793750400000000000",
};

/** An invoice the rules would otherwise ALLOW: the mandate's own purpose, no other payee, within the caps. */
const clean = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  vault: "canary.vaults.probarion.near",
  agentPk: AGENT,
  now: new Date("2026-11-10T00:00:00Z"),
  invoice: {
    invoice_hash: H("c"),
    amount: "3000000",
    po_ref: null,
    purpose_hash: H("a"),
    payee_hint: null,
  },
  proposal: null,
  attestationOk: null,
  mandates: [mandate],
  paidInvoiceHashes: new Set(),
  usedRefs: new Set(),
  intentsBalance: null,
  frozen: false,
  confidenceFloor: 0.7,
  ref: "canary-x",
  daily: null,
  ...over,
});

describe("the Canary's own rule: it never pays from its own cycle", () => {
  it("is a custom rule that always refuses, with a fixed detail", () => {
    expect(CANARY_NO_AUTOPAY_ID).toBe("custom.canary_no_autopay");
    expect(canaryNoAutopay.id).toBe(CANARY_NO_AUTOPAY_ID);
    for (const input of [clean(), clean({ frozen: true }), clean({ mandates: [] })]) {
      expect(canaryNoAutopay.check(input, mandate)).toEqual({
        id: CANARY_NO_AUTOPAY_ID,
        outcome: "refuse",
        detail: "the Canary never pays from its own cycle",
      });
    }
  });

  it("turns an invoice the policy would allow into a refusal at this rule", () => {
    const without = decide(clean());
    expect(without.verdict).toBe("allow");
    const withRule = decide(clean({ customRules: [canaryNoAutopay] }));
    expect(withRule.verdict).toBe("refuse");
    expect(withRule.rules.find((r) => r.outcome === "refuse")?.id).toBe(CANARY_NO_AUTOPAY_ID);
    expect(withRule.rules.filter((r) => r.outcome === "refuse")).toHaveLength(1);
  });

  it("shows only when nothing else refused: a real refusal keeps its own rule id, because built-in rules run first", () => {
    const cases: [string, Partial<DecisionInput>][] = [
      [
        "mandate.payee_mismatch",
        { invoice: { ...clean().invoice, payee_hint: { near_account: "mallory.near" } } },
      ],
      ["mandate.over_per_payment", { invoice: { ...clean().invoice, amount: "5000001" } }],
      [
        "invoice.po_mismatch",
        {
          invoice: { ...clean().invoice, purpose_hash: H("b") },
          // with no purpose match and no proposal there is no mandate at all (mandate.none): the model names one
          proposal: {
            action: "pay",
            mandate_id: 1,
            amount: "3000000",
            payee_hint: null,
            reasoning: "ok",
            confidence: 0.9,
          },
          attestationOk: true,
        },
      ],
      ["invoice.duplicate", { paidInvoiceHashes: new Set([H("c")]) }],
      ["vault.frozen", { frozen: true }],
    ];
    for (const [rule, over] of cases) {
      const d = decide(clean({ ...over, customRules: [canaryNoAutopay] }));
      expect(d.verdict, rule).toBe("refuse");
      expect(d.rules.find((r) => r.outcome === "refuse")?.id, rule).toBe(rule);
      // the Canary's rule is still recorded, last
      expect(d.rules.at(-1)?.id, rule).toBe(CANARY_NO_AUTOPAY_ID);
    }
  });

  it("cannot be turned into a hold or an allow by a model that says pay", () => {
    const d = decide(
      clean({
        proposal: {
          action: "pay",
          mandate_id: 1,
          amount: "3000000",
          payee_hint: null,
          reasoning: "believe me",
          confidence: 0.99,
        },
        attestationOk: true,
        customRules: [canaryNoAutopay],
      }),
    );
    expect(d.verdict).toBe("refuse");
    expect(d.rules.find((r) => r.outcome === "refuse")?.id).toBe(CANARY_NO_AUTOPAY_ID);
  });
});
