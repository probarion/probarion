import { Badge } from "@/components/ui";
import { deadlineText } from "@/lib/topup/copy";
import type { VerifiedQuote } from "@/lib/topup/oneclick";

/**
 * A quote the server verified (`checkQuote`), as the owner reads it before signing. Each green badge is a fact
 * the server checked and whose value is shown: the signature, the recipient and the refund address. The refund
 * rule and the deadline's meaning are 1Click's own documentation (the SDK's `Quote.deadline` and the `swapType`
 * EXACT_OUTPUT notes), and the text says so rather than presenting them as checked here.
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
        Checked on Probarion&apos;s server before showing you this: the signature (against the
        1Click key built into the SDK), that the quote is for this vault and this refund address,
        that it delivers at least what you asked for, that you pay at most 5% more than that, and
        that it was signed less than 5 minutes ago.
      </p>
      <p className="mt-1 text-xs text-stone-600">
        Per 1Click&apos;s API documentation, input above what the swap needs is refunded to{" "}
        {quote.refundTo} on NEAR once the swap completes. Sign before {deadlineText(quote.deadline)}
        . After that, 1Click says the deposit address becomes inactive and funds may be lost.
      </p>
      <p className="mt-1 text-xs break-all text-stone-500">
        Deposit address {quote.depositAddress}
        {quote.timeEstimate > 0
          ? ` · 1Click estimates about ${quote.timeEstimate} s once the deposit is confirmed`
          : ""}{" "}
        · quote {quote.correlationId}
      </p>
    </div>
  );
}
