import type { CustomRule, DecisionInput, MandateView, RuleResult } from "@probarion/core";

// The owner confirms, unless an attested model does. The code's amount reader (amount.ts) fails closed, but a text
// reader cannot be perfect, so the Payables pipeline pays on its own only when an attested model confirms the
// amount the code read: the model's proposal states the same amount as the code's reader, whose amount is the
// invoice amount the policy checks.
//
// The model is not an independent reader. Proposal template v1 (packages/core) shows it the code's amount in
// `facts`, so a model that echoes that amount is accepted as a confirmation. A confirming model still catches a
// gross misreading it notices and a document marked paid, the rules-only path sends nothing, and the mandate's
// caps and approval_above bound a wrong figure. A proposal template that leaves the amount out (so the model reads
// the total blind) is plan 03's to change.
//
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

/** Why no attested model confirms the code's amount, or null when one states the same amount. */
function missingConfirmation(input: DecisionInput): string | null {
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

/**
 * The custom rule the pipeline adds to every Probarion it makes. It can only hold or refuse, never allow.
 * `onCheck` hears each verdict it gives, so the pipeline knows the rule held even when another rule held first.
 */
export function ownerConfirmsRule(onCheck?: (outcome: RuleResult["outcome"]) => void): CustomRule {
  return {
    id: OWNER_CONFIRMS_RULE,
    check(input, chosen): RuleResult {
      const result = verdict(input, chosen);
      onCheck?.(result.outcome);
      return result;
    },
  };
}

function verdict(input: DecisionInput, chosen: MandateView | null): RuleResult {
  const missing = missingConfirmation(input);
  if (missing === null) {
    return {
      id: OWNER_CONFIRMS_RULE,
      outcome: "pass",
      detail: "an attested model confirms the amount the code read",
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
}

/** The rule for one cycle, and the last verdict it gave in it (null before it ran). */
export function ownerConfirms(): { rule: CustomRule; outcome: () => RuleResult["outcome"] | null } {
  let last: RuleResult["outcome"] | null = null;
  return {
    rule: ownerConfirmsRule((o) => {
      last = o;
    }),
    outcome: () => last,
  };
}
