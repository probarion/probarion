import type { RefTable } from "./types";

// The policy rules of the docs reference (/docs/build/policy-rules). Each row's rule id and effect, and
// for the built-in rules their order and the vault codes each row mirrors (one decide() case per check of
// contracts/vault/src/checks.rs), are pinned by test/docs-ref-policy.test.ts to packages/core/src/policy.ts,
// checks.rs, the RuleId type, the SDK's sources and the hosted app's custom rules. A row's anchor is its table's prefix and the rule id, with "." as "-".

/** The rules `decide()` records, in the order a decision records them, then the custom rules it runs last. */
const DECIDE_RULES: RefTable = {
  id: "policy-rules",
  label: "Rules of decide()",
  columns: [
    { key: "rule", label: "Rule id" },
    { key: "effect", label: "Effect" },
    { key: "mirrors", label: "Vault code it mirrors" },
    { key: "when", label: "When it fires" },
    { key: "todo", label: "What to do" },
  ],
  rows: [
    {
      id: "policy-contract-check_failed",
      cells: {
        rule: "`contract.check_failed`",
        effect: "Refuse",
        mirrors: "`InvalidInput`, in part",
        when: "`invoice.invoice_hash` is not 64 lowercase hex characters, or `ref` is not 1 to 64 bytes in UTF-8.",
        todo: "Fix the hash or the ref. The SDK throws `InvalidInput` for both before it decides, so through the SDK you meet this id in payment entries instead.",
      },
    },
    {
      id: "policy-vault-frozen",
      cells: {
        rule: "`vault.frozen`",
        effect: "Refuse",
        mirrors: "`Frozen`",
        when: "The input's `frozen` is true. The SDK reads it from the vault's config.",
        todo: "Find out why the owner froze the vault. Only the owner can `unfreeze` it, and then the cycle can run again.",
      },
    },
    {
      id: "policy-model-attestation_invalid",
      cells: {
        rule: "`model.attestation_invalid`",
        effect: "Note",
        mirrors: "None: off-chain only",
        when: "A `proposal` came with `attestationOk` false, because its evidence failed the checks, or null, because it had none. The proposal is ignored and the decision is rules-only. `process()` never records it: only `requestSpend()` with a proposal of your own.",
        todo: "Nothing, for this decision. For the model to count, pass evidence made for this spend that passes the attestation checks.",
      },
    },
    {
      id: "policy-model-unavailable",
      cells: {
        rule: "`model.unavailable`",
        effect: "Note",
        mirrors: "None: off-chain only",
        when: "`proposal` is null and `attestationOk` is false: a model was asked and gave no answer the SDK could use. In `process()` that is a model error, a response over 64 KiB, or evidence that fails its checks at this ledger position.",
        todo: "Nothing, for this decision. The SDK's warning names the cause. With `model: null` the SDK decides rules-only without asking a model.",
      },
    },
    {
      id: "policy-mandate-none",
      cells: {
        rule: "`mandate.none`",
        effect: "Refuse",
        mirrors: "`NoMandate`",
        when: "No mandate was chosen: a trusted proposal's `mandate_id` names no mandate in the input, or no mandate has the invoice's `purpose_hash`, or that hash is null.",
        todo: "Check the invoice's PO reference and the `purpose_hash` made from it. If no mandate covers this purpose, the owner creates one.",
      },
    },
    {
      id: "policy-mandate-inactive",
      cells: {
        rule: "`mandate.inactive`",
        effect: "Refuse",
        mirrors: "`MandateInactive`",
        when: "The chosen mandate's `status` is `revoked`. A mandate that reads `exhausted` passes here and is refused by `mandate.uses_exhausted` or `mandate.over_total`.",
        todo: "A revoked mandate stays revoked. If the payment is still wanted, the owner creates a new mandate.",
      },
    },
    {
      id: "policy-mandate-expired",
      cells: {
        rule: "`mandate.expired`",
        effect: "Refuse",
        mirrors: "`MandateExpired`",
        when: "`now`, in nanoseconds, is at or past the mandate's `expires_at_ns`, or the clock or the expiry cannot be read. The status is not read: an expired mandate still reads `active`.",
        todo: "Mandates cannot be edited. If the payment is still wanted, the owner creates a new mandate with a later expiry.",
      },
    },
    {
      id: "policy-mandate-agent_mismatch",
      cells: {
        rule: "`mandate.agent_mismatch`",
        effect: "Refuse",
        mirrors: "`NotMandateAgent`",
        when: "The mandate's `agent_pk` is not the input's `agentPk`, the public key of the agent key that signs the spend.",
        todo: "Sign with the agent key the mandate names, or have the owner create a mandate for this key.",
      },
    },
    {
      id: "policy-invoice-po_mismatch",
      cells: {
        rule: "`invoice.po_mismatch`",
        effect: "Refuse",
        mirrors: "None: off-chain only",
        when: "The invoice's `purpose_hash` is null, differs from the chosen mandate's, or selects another mandate than the one a trusted proposal chose.",
        todo: "Check the PO reference and its `purpose_hash`. When a model chose the mandate, the purpose wins.",
      },
    },
    {
      id: "policy-mandate-payee_mismatch",
      cells: {
        rule: "`mandate.payee_mismatch`",
        effect: "Refuse",
        mirrors: "None: off-chain only",
        when: "The invoice's `payee_hint`, or the trusted proposal's, contradicts the mandate's payee. For a NEAR payee: another `near_account`, or any `address` or `chain`. For a Base or Solana payee: any `near_account`, another `chain`, or another `address`, compared without case on Base. A `name` never contradicts.",
        todo: "Do not pay. The invoice names a destination the mandate does not pay, and a mandate's payee never changes. If the payee really changed, the owner creates a new mandate.",
      },
    },
    {
      id: "policy-invoice-amount_invalid",
      cells: {
        rule: "`invoice.amount_invalid`",
        effect: "Refuse",
        mirrors: "`ZeroAmount`, in part",
        when: "`invoice.amount` is not a whole number string from 1 up to the u128 maximum, with no sign, point or leading zero, or a trusted proposal's `amount` is set and differs from it, character for character.",
        todo: "Write the amount in the token's smallest units: `10000000` for 10 USDC. If the model read another amount, check the invoice by hand.",
      },
    },
    {
      id: "policy-mandate-over_per_payment",
      cells: {
        rule: "`mandate.over_per_payment`",
        effect: "Refuse",
        mirrors: "`OverPerPayment`",
        when: "The amount is above the mandate's `max_per_payment`, or that cap cannot be read. An amount equal to the cap passes.",
        todo: "Do not pay it under this mandate. If the amount is right, the owner creates a mandate with a higher cap.",
      },
    },
    {
      id: "policy-mandate-uses_exhausted",
      cells: {
        rule: "`mandate.uses_exhausted`",
        effect: "Refuse",
        mirrors: "`UsesExhausted`",
        when: "The mandate's `uses` is not below its `max_uses`, which includes a count that is not a number.",
        todo: "Wait for a held spend to be rejected or to expire, which gives its use back, or have the owner create a new mandate.",
      },
    },
    {
      id: "policy-mandate-over_total",
      cells: {
        rule: "`mandate.over_total`",
        effect: "Refuse",
        mirrors: "`OverMandateTotal`",
        when: "`spent` plus `reserved` plus the amount is above `max_total`, or one of the three cannot be read. The sum stops at the u128 maximum, as the contract's does.",
        todo: "Wait for a held spend to be rejected or to expire, which frees its reservation, or have the owner create a new mandate.",
      },
    },
    {
      id: "policy-invoice-duplicate",
      cells: {
        rule: "`invoice.duplicate`",
        effect: "Refuse",
        mirrors: "`DuplicateInvoice`, `DuplicateRef`",
        when: "The invoice hash is in `paidInvoiceHashes`, checked first, or the ref is in `usedRefs`. The SDK fills them from the vault's spends: the invoices of held, pending, paid and burned spends, and the ref of every spend.",
        todo: 'Read the detail. When it says the invoice "was already paid or is pending", do not pay it again. When it says the ref "was already used", run the cycle again under a new ref.',
      },
    },
    {
      id: "policy-vault-daily_backstop",
      cells: {
        rule: "`vault.daily_backstop`",
        effect: "Refuse",
        mirrors: "`OverDailyBackstop`",
        when: "`daily.spent_today` plus the amount is above `daily.backstop`, or either cannot be read. The SDK passes the vault's backstop and the total of its live spends created on the UTC day of `now`.",
        todo: "Wait for the next UTC day. The backstop is one limit for the whole vault, set when the vault is created.",
      },
    },
    {
      id: "policy-intents-balance_low",
      cells: {
        rule: "`intents.balance_low`",
        effect: "Hold",
        mirrors: "None: off-chain only",
        when: "The mandate pays a Base or Solana address through NEAR Intents, and `intentsBalance` is null or below the amount. The SDK reads the vault's balance of the mandate's asset inside NEAR Intents, and a failed read gives null.",
        todo: "The owner tops up the vault's balance of that asset inside NEAR Intents, then the cycle runs again. A NEAR payee never holds here.",
      },
    },
    {
      id: "policy-model-refused",
      cells: {
        rule: "`model.refused`",
        effect: "Hold or refuse",
        mirrors: "None: off-chain only",
        when: "A trusted proposal's `action` is `hold`, which holds, or `refuse` or any value other than `pay`, which refuses. `pay` passes.",
        todo: "Check the invoice yourself. For `hold` and `refuse` the detail quotes the model's reasoning, cut at 200 characters. For another action it names that action.",
      },
    },
    {
      id: "policy-model-low_confidence",
      cells: {
        rule: "`model.low_confidence`",
        effect: "Hold",
        mirrors: "None: off-chain only",
        when: "A trusted proposal's `confidence` is not at or above `confidenceFloor`: 0.7 by default (`DEFAULT_CONFIDENCE_FLOOR`), or the SDK's `confidenceFloor` option, from 0 to 1. A confidence that is not a number holds.",
        todo: "Check the invoice yourself before you run the cycle again, which asks the model again.",
      },
    },
    {
      id: "policy-custom",
      cells: {
        rule: "`custom.<name>`",
        effect: "Hold or refuse",
        mirrors: "None: off-chain only",
        when: "Your rule's `check(input, chosen)` returned `hold` or `refuse`. It also refuses when its id does not start with `custom.`, its outcome is not `pass`, `hold` or `refuse`, or `check` throws. The result is recorded under the rule's own `id`, whatever id `check` returns.",
        todo: "Your own code decided: read its detail.",
      },
    },
  ],
};

/** The rule ids the SDK and Probarion's hosted cycles record next to `decide()`'s. */
const ADDED_RULES: RefTable = {
  id: "policy-added",
  label: "Rule ids recorded outside decide()",
  columns: [
    { key: "rule", label: "Rule id" },
    { key: "effect", label: "Effect" },
    { key: "by", label: "Recorded by" },
    { key: "when", label: "When" },
    { key: "todo", label: "What to do" },
  ],
  rows: [
    {
      id: "policy-added-ledger-unresolved",
      cells: {
        rule: "`ledger.unresolved`",
        effect: "Refuse",
        by: "The SDK, in the decision entry, after `decide()`",
        when: "An earlier payment entry of this invoice in the same ledger has the status `unknown`, and none of these holds yet: a later payment entry of that decision knows its status, a spend on chain carries the decision's hash, or 48 hours (`UNKNOWN_SETTLE_MS`) have passed since that entry. It refuses in raw mode too.",
        todo: "Never send it again. Find the spend by its ref in the vault's spends, or wait until the time the detail names.",
      },
    },
    {
      id: "policy-added-contract-check_failed",
      cells: {
        rule: "`contract.check_failed`",
        effect: "Refuse",
        by: "The SDK, in the payment entry",
        when: "`check_spend` refused, `spend` panicked, or the spend failed without the vault releasing it: a transaction that did not run, or a spend receipt that failed without a vault code. The detail says which.",
        todo: "Read the payment entry's `contract.code` and look it up on the Errors page.",
      },
    },
    {
      id: "policy-added-invoice-duplicate",
      cells: {
        rule: "`invoice.duplicate`",
        effect: "Note",
        by: "The SDK, in the payment entry",
        when: "The vault answered `DuplicateRef` or `DuplicateInvoice` to a re-signed copy of this spend, and the SDK found this decision's own spend by its ref with the status `paid`, `burned` or `held`. The rule passes and names that spend.",
        todo: "Nothing: the outcome reports that spend as it stands.",
      },
    },
    {
      id: "policy-added-custom-raw_mode",
      cells: {
        rule: "`custom.raw_mode`",
        effect: "Note",
        by: "The SDK, as the first rule of a raw-mode decision",
        when: "`requestSpend()` ran with `skipPreflight: true`, which is meant for the Canary only. The code rules and `check_spend` are skipped and `spend` is always sent. Of the code rules, only `ledger.unresolved` can still refuse.",
        todo: "Nothing: the vault alone decides. A panic comes back as `refused_by_contract` with the failed transaction's hash.",
      },
    },
    {
      id: "policy-added-custom-invoice_number_duplicate",
      cells: {
        rule: "`custom.invoice_number_duplicate`",
        effect: "Refuse",
        by: "Payables (Preview), as the first custom rule of the cycle, before `custom.owner_confirms_without_model`",
        when: "Another invoice to the same payee has the same invoice number, and it may have paid or may still pay: it is processing, sent and not yet confirmed, waiting for the owner, or decided as paid, burned, settled, held on chain with a spend, or refused because its own text was already paid or may still pay (`invoice.duplicate` or `ledger.unresolved` in its decision, or the contract's `DuplicateInvoice` or `DuplicateRef`). The texts differ: the same text is refused at intake as a duplicate, with no cycle. The detail names the earlier invoice by its invoice hash, not by its number, and names one that may have paid before one that waits for the owner. When a built-in rule of `decide()` refuses first, the outcome's code is that rule's, and the refusal is final like any other.",
        todo: 'Nothing was sent. Look at the earlier invoice the detail names. If it waits for the owner, upload this one again once the owner rejects it in the console, and any other invoice with this number that waits for them: it runs on the same row and ref. If the console shows this invoice as "Outcome unknown: do not resend", its refusal could not be written, and the number stays blocked whatever happens to the earlier invoice. Otherwise the number stays blocked while that invoice may still pay, and a paid invoice is not paid again, even when an agent paid its text outside the console and the console refused it as already paid. The console does not yet free the number of an invoice held on chain, sent and not confirmed, or with an unknown outcome when its spend fails, is rejected or expires.',
      },
    },
    {
      id: "policy-added-custom-owner_confirms_without_model",
      cells: {
        rule: "`custom.owner_confirms_without_model`",
        effect: "Hold or refuse",
        by: "Payables, the console's reference agent (Preview), on every cycle but the owner's confirmed one",
        when: "No attested model stated the amount the code read: no proposal, one that is not attested, or a model amount that is null or differs. It holds, or refuses when the amount is above the mandate's `approval_above` or cannot be compared, since a hold would then send the spend for approval.",
        todo: "The vault's owner confirms the amount in the console, on the invoice's \"Waiting for you\" card.",
      },
    },
    {
      id: "policy-added-custom-owner_confirmed",
      cells: {
        rule: "`custom.owner_confirmed`",
        effect: "Refuse",
        by: "Payables (Preview), in the cycle that runs after the owner confirms",
        when: "The decision does not pay exactly what the owner signed for: another amount, invoice hash, mandate or payee, or no mandate. When it passes, its detail holds the owner's whole signed confirmation.",
        todo: "Nothing was sent. Compare the confirmed amount, invoice and mandate with the decision's.",
      },
    },
    {
      id: "policy-added-custom-canary_no_autopay",
      cells: {
        rule: "`custom.canary_no_autopay`",
        effect: "Refuse",
        by: "The Canary, Probarion's public-challenge vault (Live on testnet), on every cycle",
        when: "Always: the Canary never pays from its own cycle. It is the outcome's `code` only when no built-in rule refused first.",
        todo: "Nothing: it is the expected refusal there.",
      },
    },
  ],
};

/** The policy tables of the docs reference. */
export const TABLES: readonly RefTable[] = [DECIDE_RULES, ADDED_RULES];
