// One plain line per rule id that can refuse or hold a decision: what the rule found, in words a visitor reads without
// the docs. Each line is a short form of that rule's "When it fires" in the policy reference (lib/docs/ref/policy.ts),
// and reasons.test.ts holds the ids to that reference: every rule there that refuses or holds has a line here, and
// nothing else does. A line has no full stop of its own: the page ends it with the rule id in parentheses, then the
// stop ("The mandate has expired (mandate.expired)."). This file is imported by the client form, so it is plain data
// and reaches no other module.

/** The plain reason of each rule id, by id. The template row `custom.<name>` has none: it is no id. */
export const RULE_REASONS: Readonly<Record<string, string>> = {
  "contract.check_failed": "The request was not one the vault can check, or the vault refused it",
  "vault.frozen": "The vault's owner froze it, so it pays nothing until the owner unfreezes it",
  "mandate.none": "No mandate covers this payment",
  "mandate.inactive": "The mandate was revoked",
  "mandate.expired": "The mandate has expired",
  "mandate.agent_mismatch": "The key that would sign is not the agent key the mandate names",
  "invoice.po_mismatch": "The text's purpose does not match the mandate's",
  "mandate.payee_mismatch": "The text names a payee the mandate does not pay",
  "invoice.amount_invalid":
    "Code found no amount it could read with certainty, or the model's amount is not the one code read",
  "mandate.over_per_payment": "The amount is above what this mandate allows per payment",
  "mandate.uses_exhausted": "The mandate has no payments left",
  "mandate.over_total": "The amount would take the mandate past its total cap",
  "invoice.duplicate": "This invoice, or its reference, was already used",
  "vault.daily_backstop": "The amount would take the vault past its daily limit",
  "intents.balance_low": "The vault's balance in NEAR Intents is too low for this payment",
  "model.refused": "The model itself did not propose to pay",
  "model.low_confidence": "The model was not confident enough",
  "ledger.unresolved": "An earlier payment of this invoice has an outcome that is not known yet",
  "custom.invoice_number_duplicate":
    "Another invoice to the same payee has this invoice number, and it may have paid",
  "custom.owner_confirms_without_model":
    "No attested model stated the amount code read, so the vault's owner confirms it",
  "custom.owner_confirmed": "The decision does not pay exactly what the owner confirmed",
  "custom.canary_no_autopay": "The Canary's own rule: it never pays from its own cycle",
};

/** The plain reason of `id`, or null for an id this list does not know (the page then shows the id alone). */
export function ruleReason(id: string): string | null {
  return Object.hasOwn(RULE_REASONS, id) ? (RULE_REASONS[id] ?? null) : null;
}
