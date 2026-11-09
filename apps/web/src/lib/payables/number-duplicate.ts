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
      return "has an unknown outcome";
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

/**
 * What the console says after this rule refused an upload, by what happened to the earlier invoice. invoice_insert
 * (0016) runs this text again only once no invoice that may pay has the number. The one owner action that always
 * frees it is a Reject of an earlier invoice that waits for them (0007 invoice_reject clears its number). A Confirm is
 * not offered: it can end with the spend held on chain, which blocks the number; with a failure that leaves the row
 * waiting or in processing; or with a refusal because that invoice's text was already paid or may still pay
 * (invoice.duplicate, the contract's DuplicateInvoice), which frees the number of a bill that was paid. Nothing in the
 * app moves a paid invoice, a spend held on chain, a payment sent but not confirmed, or a row left in processing (its
 * cycle was cut off or could not record its outcome: the tenant lease means no cycle is still running when this one
 * inserts), even once that spend fails, is rejected or expires.
 *
 * The notice gives no advice to reissue the bill under a new number. The console cannot show that the earlier spend
 * can no longer pay: a held spend may still be approved, a transaction whose outcome is unknown can land for 48 hours
 * (UNKNOWN_SETTLE_MS), and a new number passes both guards and the contract's DuplicateInvoice. So the bill could be
 * paid twice.
 *
 * `recorded` is false when this cycle's refusal could not be written to the new invoice's row. The row stays in
 * processing, so an upload of this text again answers 409, and the number stays blocked whatever happens to the
 * earlier invoice.
 */
export function numberDuplicateNotice(match: NumberMatch, recorded: boolean): string {
  if (!recorded)
    return "Duplicate number: another invoice to this payee has the same invoice number. Nothing was sent, but the refusal could not be written to this invoice: it shows as processing, and the number stays blocked.";
  const head =
    "Duplicate number: another invoice to this payee has the same invoice number. Nothing was sent; the refusal is in the signed ledger.";
  const notFreed =
    "The console does not yet free a number when that spend fails, is rejected or expires.";
  switch (match.status) {
    case "awaiting_owner":
      return `${head} That invoice waits for the owner. If the owner rejects it, upload this one again.`;
    case "processing":
      return `${head} That invoice's outcome is unknown and it may have paid, so the number stays blocked. ${notFreed}`;
    case "unconfirmed":
      return `${head} That invoice's payment was sent and is not confirmed, so the number stays blocked. ${notFreed}`;
    case "decided":
      return match.outcome_status === "held"
        ? `${head} That invoice's spend is held on chain for an approver, so the number stays blocked. ${notFreed}`
        : `${head} That invoice was paid, so this one is not paid again.`;
    default:
      return `${head} The number stays blocked while that invoice may still pay.`;
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
