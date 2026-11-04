import type { CustomRule, DecisionInput, MandateView, RuleResult } from "@probarion/core";

// Two readers or the owner. The code's amount reader (amount.ts) fails closed, but a text reader cannot be
// perfect, so the Payables pipeline sends a payment on its own only when two independent readers agree on it:
//   1. the code's reader, whose amount is the invoice amount the policy checks;
//   2. an attested model, whose proposal states the same amount.
// decide() already refuses when a trusted model's amount differs from the code's (invoice.amount_invalid). This
// rule covers the rest: with no attested model (no NEARAI_API_KEY, a model that failed, a proposal that is not
// attested) or a model that states no amount, nothing is sent, and the invoice waits for the owner to confirm
// the code's amount.
//
// How the SDK sends nothing: a `hold` verdict sends no spend when the contract would pay the amount at once (the
// SDK holds it off-chain, after the free check_spend dry run). When the contract would itself hold the amount
// (above the mandate's approval_above), the SDK sends the spend for the approver instead, and that reserves the
// mandate's funds. So in that one case the rule refuses: the decision is recorded, nothing is sent, and the
// invoice still waits for the owner.

/** The rule id; an outcome whose code is this id waits for the owner (pipeline.ts). */
export const OWNER_CONFIRMS_RULE = "custom.owner_confirms_without_model" as const;

const CANONICAL = /^(?:0|[1-9][0-9]{0,38})$/;

/** Why no second reader agrees with the code, or null when an attested model read the same amount. */
function missingSecondReader(input: DecisionInput): string | null {
  const p = input.proposal;
  if (p === null) return "no model read this invoice";
  if (input.attestationOk !== true) return "the model's reading is not attested";
  if (p.amount === null) return "the attested model stated no amount";
  if (p.amount !== input.invoice.amount) return "the attested model read another amount";
  return null;
}

/** True when the contract would hold this amount for its approver, so that a `hold` verdict would send it. */
function contractWouldHold(input: DecisionInput, chosen: MandateView | null): boolean {
  if (chosen === null) return false; // mandate.none refuses: nothing is sent
  const amount = input.invoice.amount;
  const above = String(chosen.approval_above);
  if (!CANONICAL.test(amount) || !CANONICAL.test(above)) return true; // unknown: refuse, never send
  return BigInt(amount) > BigInt(above); // contracts/vault/src/checks.rs:68
}

/** The custom rule the pipeline adds to every Probarion it makes. It can only hold or refuse, never allow. */
export function ownerConfirmsRule(): CustomRule {
  return {
    id: OWNER_CONFIRMS_RULE,
    check(input, chosen): RuleResult {
      const missing = missingSecondReader(input);
      if (missing === null) {
        return {
          id: OWNER_CONFIRMS_RULE,
          outcome: "pass",
          detail: "an attested model read the same amount as the code",
        };
      }
      const holds = contractWouldHold(input, chosen);
      return {
        id: OWNER_CONFIRMS_RULE,
        outcome: holds ? "refuse" : "hold",
        detail: holds
          ? `${missing}: nothing is sent; the owner confirms the amount (above the approval threshold, a hold would send it for approval)`
          : `${missing}: nothing is sent; the owner confirms the amount`,
      };
    },
  };
}
