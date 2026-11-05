import { Badge } from "@/components/ui";
import { deadlineText } from "@/lib/topup/copy";
import type { VerifiedQuote } from "@/lib/topup/oneclick";

/**
 * A quote the server verified (`checkQuote`), as the owner reads it before signing. Each green badge is a fact
 * the server checked and whose value is shown: the signature, the recipient and the refund address. The refund
 * rule and the deadline's meaning are 1Click's own documentation (the SDK's `Quote.deadline` and the `swapType`
 * EXACT_OUTPUT notes), and the text says so rather than presenting them as checked here. Only signed values
 * are shown here: the 1Click reference is not covered by the signature, so it is `QuoteReference`, apart.
 */
export function QuoteSummary({ quote }: { quote: VerifiedQuote }) {
  return (
    <div className="text-sm">
      <p className="mb-2 flex flex-wrap gap-1">
        <Badge tone="good">Signature verified</Badge>
        <Badge tone="good">Recipient = {quote.recipient} (Intents account)</Badge>
        <Badge tone="good">Refund address = {quote.refundTo}</Badge>
      </p>
      <p>
        You send <strong>{quote.amountInFormatted} USDC</strong> on NEAR. This signed quote has
        1Click credit <strong>{quote.amountOutFormatted} Base USDC</strong> to {quote.recipient}
        &apos;s account in NEAR Intents.
      </p>
      <p className="mt-1 text-xs text-stone-600">
        Checked on Probarion&apos;s server before showing you this: the signature (against
        1Click&apos;s signing key as pinned in Probarion and in its SDK); that the signed request is
        the one Probarion sent (this vault as recipient, your refund address, the assets, the
        amount, the slippage, no extra routing); that the quote delivers at least what you asked
        for; that you pay at most 5% more than that; that it was signed less than 5 minutes ago; and
        that its deposit address is not this vault, your account, or the USDC or Intents contract.
      </p>
      <p className="mt-1 text-xs text-stone-600">
        Per 1Click&apos;s API documentation, input above what the swap needs is refunded to{" "}
        {quote.refundTo} on NEAR once the swap completes. Your deposit must reach 1Click before{" "}
        {deadlineText(quote.deadline)}. After that, 1Click says the deposit address becomes inactive
        and funds may be lost.
      </p>
      <p className="mt-1 text-xs break-all text-stone-500">
        Deposit address {quote.depositAddress}
        {quote.timeEstimate > 0
          ? ` · 1Click estimates about ${quote.timeEstimate} s once the deposit is confirmed`
          : ""}
      </p>
    </div>
  );
}

/** The id 1Click gave the quote, for a support question. It is not part of what the signature covers. */
export function QuoteReference({ id }: { id: string }) {
  return (
    <p className="mt-1 text-xs break-all text-stone-500">
      1Click reference {id} (not covered by the signature).
    </p>
  );
}
