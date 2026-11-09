// The checks an invoice queued by the browser extension passes (spec §4.4 and D3), as its row keeps them (migration
// 0015's queue_checks) and the console shows them under "Why it waits". A check is only pass or hold: an invoice a
// check refuses is never stored.

/** D3: the member chose the mandate and no purpose document was matched, so only the owner's signed Confirm pays it. */
export const EXTENSION_MANDATE_RULE = "extension.mandate_chosen";
/** The contract's free check_spend view, run for the mandate's agent key when the invoice is queued. */
export const CHECK_SPEND_RULE = "contract.check_spend";
/** The invoice's payee hint against the mandate's payee (core's payeeHintContradiction, the cycle's own check). */
export const PAYEE_RULE = "mandate.payee_mismatch";

export interface QueueCheck {
  id: string;
  outcome: "pass" | "hold";
  detail: string;
}
