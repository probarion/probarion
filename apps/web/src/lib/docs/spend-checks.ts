import type { VaultErrorCode } from "@probarion/core";

/**
 * The vault contract's spend checks, in the order `evaluate` runs them (contracts/vault/src/checks.rs). The first one
 * that fails is the answer. A test pins the order to the Rust source.
 */
export const SPEND_CHECKS: readonly { code: VaultErrorCode; question: string }[] = [
  { code: "NotAgent", question: "Is the signing key one of the vault's agent keys?" },
  {
    code: "InvalidInput",
    question:
      "Are `invoice_hash` and `decision_hash` 64 lowercase hex characters, and is `ref` 1 to 64 bytes?",
  },
  { code: "Frozen", question: "Is the vault not frozen?" },
  { code: "NoMandate", question: "Does the vault have a mandate with this id?" },
  { code: "MandateInactive", question: "Is the mandate not revoked?" },
  { code: "MandateExpired", question: "Is it still before the mandate's `expires_at_ns`?" },
  { code: "NotMandateAgent", question: "Is the signing key the agent key this mandate names?" },
  { code: "ZeroAmount", question: "Is the amount more than zero?" },
  { code: "OverPerPayment", question: "Is the amount at most the mandate's `max_per_payment`?" },
  { code: "UsesExhausted", question: "Has the mandate been used fewer than `max_uses` times?" },
  {
    code: "OverMandateTotal",
    question:
      "Do the mandate's spent and reserved amounts, plus this one, stay within `max_total`?",
  },
  {
    code: "DuplicateInvoice",
    question: "Is this `invoice_hash` not already in use by another spend?",
  },
  { code: "DuplicateRef", question: "Has the vault never accepted a spend with this `ref`?" },
  {
    code: "OverDailyBackstop",
    question:
      "Does the vault's total for this UTC day, plus this amount, stay within the daily backstop?",
  },
];
