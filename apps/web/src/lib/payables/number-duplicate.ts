import { type CustomRule, describePayee, type Payee, type RuleResult } from "@probarion/core";
import type { NumberMatch } from "./store";

// A second invoice with the same number for the same payee is refused by code, in the signed ledger. The duplicate
// guard (migrations 0006 and 0016) answers the same text and the same rendered text at intake, with no cycle. When the
// only match is on the invoice-number key (pipeline.ts invoiceNumberKey: the vault, the mandate's payee and the
// number), the invoice is another text of what may be the same bill, such as a re-sent INV-2001 with another total or
// a PDF that renders other text. The row is inserted, and the pipeline adds this rule to the cycle, so decide()
// refuses it: nothing is sent, and the decision entry says why, signed by the ledger key.
//
// The detail names the earlier invoice by its invoice hash, which its own ledger entries carry, and never by its
// number: in zero-retention mode the number is kept only as a keyed hash.

/** The rule id; the pipeline adds it before the owner-confirms rule, so a refusal's code is this id. */
export const NUMBER_DUPLICATE_RULE = "custom.invoice_number_duplicate" as const;

/** What happened to the earlier invoice, in the words of the rule's detail. */
function earlierState(m: NumberMatch): string {
  switch (m.status) {
    case "processing":
      return "is being processed";
    case "unconfirmed":
      return "was sent, confirmation pending";
    case "awaiting_owner":
      return "waits for the owner";
    case "decided":
      return m.outcome_status === "held" ? "is held for approval" : "was paid";
    default:
      return `has status ${m.status}`;
  }
}

/** The rule for one cycle whose invoice number matches `match` for `payee`. It only refuses. */
export function numberDuplicateRule(match: NumberMatch, payee: Payee): CustomRule {
  const detail = `another invoice to ${describePayee(payee)} has the same invoice number: invoice ${match.invoice_hash}, which ${earlierState(match)}. Nothing is sent.`;
  return {
    id: NUMBER_DUPLICATE_RULE,
    check: (): RuleResult => ({ id: NUMBER_DUPLICATE_RULE, outcome: "refuse", detail }),
  };
}
