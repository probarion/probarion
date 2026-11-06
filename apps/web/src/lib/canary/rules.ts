import type { CustomRule } from "@probarion/core";

/** The id of the Canary's own rule in a decision's rule list. It shows as the refusal only when no built-in rule refused. */
export const CANARY_NO_AUTOPAY_ID = "custom.canary_no_autopay" as const;

/**
 * The Canary never pays from its own cycle: whatever the model and the other rules say, `process()` does not send a
 * spend. Without it an anonymous invoice with no payee that fits the mandate's caps is ALLOWED by the policy (the facts
 * carry the mandate's own purpose, so the PO check passes) and the vault pays the mandate's payee, in every mode.
 *
 * It always refuses, so it can only tighten the verdict. Built-in rules run before custom ones, so a real refusal
 * (`mandate.payee_mismatch`, a cap, a duplicate) keeps its own rule id, and this one is the refusal only when nothing
 * else refused. The Canary's payments, if any, are the raw spends the contract itself refuses (service.ts).
 */
export const canaryNoAutopay: CustomRule = {
  id: CANARY_NO_AUTOPAY_ID,
  check: () => ({
    id: CANARY_NO_AUTOPAY_ID,
    outcome: "refuse",
    detail: "the Canary never pays from its own cycle",
  }),
};
