/** A quote with less than this left is not offered for signing: a wallet needs time, and the address closes at the deadline. */
export const MIN_LEFT_MS = 60_000;

export type QuoteBlock = "sent" | "expired" | "changed";

export const BLOCK_TEXT: Record<QuoteBlock, string> = {
  sent: "This deposit was sent. To top up again, get a new quote.",
  expired:
    "This quote has expired or is about to, so it is not offered for signing. Get a new quote.",
  changed: "The amount changed after this quote. Get a new quote for the new amount.",
};

/**
 * Why the panel switches off the "sign" button for a quote, or null while it is offered. A deposit that went
 * through is never offered again (a second signature would deposit twice). Once the owner has started to sign,
 * nothing else switches the button off under their wallet.
 */
export function quoteBlock(i: {
  deadline: string;
  /** The amount typed when the quote was asked for, and the amount typed now. */
  asked: string;
  amount: string;
  now: number;
  attempted: boolean;
  sent: boolean;
}): QuoteBlock | null {
  if (i.sent) return "sent";
  if (i.attempted) return null;
  // `!(x >= y)`, not `x < y`: a deadline that is not a date is expired.
  if (!(Date.parse(i.deadline) - i.now >= MIN_LEFT_MS)) return "expired";
  if (i.amount.trim() !== i.asked) return "changed";
  return null;
}
