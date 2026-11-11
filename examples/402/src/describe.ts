// One line per call, as run-agent and run-demo print them.
import { formatUsdc } from "@probarion/mcp";
import type { CallResult, Deal } from "./agent.js";

/** The quote and what the agent did about its price, up to the payment. */
function priceText(d: Deal, priceUsdc: string): string {
  if (!d.countered) return `402 for ${priceUsdc} USDC`;
  const cap = formatUsdc(d.limitUnits);
  return `402 for ${formatUsdc(d.listUnits)} USDC, above the mandate's ${cap}: countered once at ${cap}, taken as quote ${d.counteredQuoteId}`;
}

export function describeCall(
  tag: string,
  r: CallResult,
  opts: { testDouble?: boolean } = {},
): string {
  const tx = (explorer: string | null, hash: string | null) =>
    opts.testDouble === true ? `test-double tx ${hash ?? "none"}` : (explorer ?? "");
  switch (r.kind) {
    case "free":
      return `${tag} ${r.status} without payment`;
    case "no_mandate":
      return `${tag} 402, but no mandate of this vault pays ${r.payee}: nothing was sent`;
    case "walked_away":
      return `${tag} 402 for ${r.listUsdc} USDC, above the mandate's ${r.counterUsdc}: countered once at ${r.counterUsdc} -> ${r.answer.status} ${r.answer.reason}. Walked away: no payment was asked for.`;
    case "paid": {
      const check =
        r.dataCheck === null
          ? ""
          : r.dataCheck.ok
            ? ", data check passed"
            : `, data check FAILED (${r.dataCheck.problems.join("; ")}): paid anyway, not refunded`;
      const spendId = r.spend.spend_id ?? r.spend.earlier_spend?.spend_id;
      const data = JSON.stringify((r.body as { data?: unknown }).data ?? r.body);
      const paid = r.deal.countered ? `paid ${r.priceUsdc}` : "paid";
      return `${tag} ${priceText(r.deal, r.priceUsdc)} -> ${paid}, spend ${spendId} ${tx(r.spend.explorer, r.spend.tx_hash)} -> ${r.status}${check} ${data}`;
    }
    case "refused":
      return `${tag} ${priceText(r.deal, r.priceUsdc)} -> ${r.spend.status} (${r.spend.code}): ${r.spend.note} The contract's own check_spend says: ${r.contract.ok ? "ok" : r.contract.code}.`;
    case "pending":
      return `${tag} ${priceText(r.deal, r.priceUsdc)} -> ${r.spend.status}, spend ${r.spendId ?? "unknown"} still ${r.lastStatus}: not redeemed and not sent again. ${r.spend.note}`;
    case "failed":
      return `${tag} ${priceText(r.deal, r.priceUsdc)} -> failed: ${r.spend.note}`;
  }
}
