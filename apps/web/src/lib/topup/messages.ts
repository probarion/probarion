import { ONLY_ON_MAINNET } from "./copy";

/**
 * The sentence the top-up panel shows when `/api/topup/quote` answers with an error, from the HTTP status
 * and the JSON body it sent. Plain text: the page escapes it. Kept apart from the panel so it is tested
 * and so the panel does not load anything heavy.
 */
export function quoteErrorText(status: number, body: unknown): string {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const code = typeof b.error === "string" ? b.error : "";
  const detail = typeof b.detail === "string" && b.detail !== "" ? b.detail : "";
  switch (code) {
    case "mainnet_only":
      return `${ONLY_ON_MAINNET}.`;
    case "not_configured":
      return "1Click quotes are not set up on this server.";
    case "invalid_amount":
      return detail || "Enter an amount between 1 and 1000 USDC.";
    case "asset_not_allowed":
      return "This vault does not allow Base USDC, so it could not pay a Base payee from it.";
    case "quote_rejected":
      return detail
        ? `Probarion's checks refused the quote (${detail}), so nothing is offered to sign. Try again.`
        : "Probarion's checks refused the quote, so nothing is offered to sign. Try again.";
    case "quote_unavailable":
      return detail ? `1Click gave no quote: ${detail}` : "1Click gave no quote.";
    case "rate_limited":
      return `Too many quote requests. ${detail || "Try again in a minute."}`;
    case "chain_unavailable":
      return detail || "The vault could not be read from NEAR. Try again.";
    case "unavailable":
      return `A service this page needs is not available. ${detail || "Try again in a minute."}`;
    case "status_unavailable":
      return detail || "1Click could not report the deposit's status right now.";
    case "bad_origin":
      return "The request did not come from this site, so it was refused. Reload the page and try again.";
    case "invalid_input":
      return "The request was not understood. Reload the page and try again.";
    case "unauthenticated":
      return "Your session ended. Sign in again.";
    case "forbidden":
      return "Only this vault's owner can top it up.";
    default:
      return `The quote could not be requested (${code || `HTTP ${status}`}).`;
  }
}
