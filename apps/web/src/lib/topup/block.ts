/** A quote with less than this left is not offered for signing: a wallet needs time, and the address closes at the deadline. */
export const MIN_LEFT_MS = 60_000;

/** The one 1Click status that says no deposit has reached the address yet. Any other word means one was seen or the swap ended. */
export const NO_DEPOSIT_YET = "PENDING_DEPOSIT";

export type QuoteBlock = "sent" | "processing" | "expired" | "changed";

export const BLOCK_TEXT: Record<QuoteBlock, string> = {
  sent: "A deposit for this quote was sent, or may have been. To top up again, get a new quote.",
  processing:
    "1Click no longer reports this deposit address as waiting for a deposit, so the quote is not offered for signing again.",
  expired:
    "This quote has expired or is about to, so it is not offered for signing. Get a new quote.",
  changed: "The amount changed after this quote. Get a new quote for the new amount.",
};

/**
 * Why the panel switches off the "sign" button for a quote, or null while it is offered. Every guard applies
 * every time: a cancelled, failed or unconfirmed attempt never lifts one. A quote is used up once a deposit for it
 * was sent or may have been (`used`), and a deposit address 1Click no longer reports as waiting is never offered
 * again, so the same address cannot be paid twice or after its deadline.
 */
export function quoteBlock(i: {
  deadline: string;
  /** The amount typed when the quote was asked for, and the amount typed now. */
  asked: string;
  amount: string;
  now: number;
  /** A deposit for this quote was sent, or may have been (see `onDepositResult`). */
  used: boolean;
  /** 1Click's last status for this quote's deposit address, or null when none was read. */
  depositStatus: string | null;
}): QuoteBlock | null {
  if (i.used) return "sent";
  if (i.depositStatus !== null && i.depositStatus !== NO_DEPOSIT_YET) return "processing";
  // `!(x >= y)`, not `x < y`: a deadline that is not a date is expired.
  if (!(Date.parse(i.deadline) - i.now >= MIN_LEFT_MS)) return "expired";
  if (i.amount.trim() !== i.asked) return "changed";
  return null;
}
