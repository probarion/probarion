// The buying agent. It calls the endpoint; on a 402 it reads the quote, finds the mandate whose payee is the
// quote's payee, pays through the probarion-mcp tools, and calls again with the payment headers. It does not
// count uses or caps itself: the mandate is enforced by Probarion's rules and by the vault contract.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { formatUsdc } from "@probarion/mcp";
import { PAYMENT_HEADERS } from "./paywall.js";
import { parseQuote, quoteHash } from "./quote.js";

interface ToolText {
  isError: boolean;
  text: string;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: { type: string; text?: string }[];
  };
  const out: ToolText = {
    isError: r.isError === true,
    text: (r.content ?? []).map((c) => c.text ?? "").join("\n"),
  };
  if (out.isError) throw new Error(`${name}: ${out.text}`);
  return JSON.parse(out.text) as Record<string, unknown>;
}

interface MandateRow {
  id: number;
  status: string;
  payee_detail: { type: string; account_id?: string };
}

export interface SpendResult {
  status: string;
  spend_id: number | null;
  code: string | null;
  tx_hash: string | null;
  explorer: string | null;
  note: string;
}

export type CallResult =
  | { kind: "free"; status: number; body: unknown }
  | { kind: "paid"; status: number; body: unknown; spend: SpendResult; priceUsdc: string }
  | {
      kind: "refused";
      spend: SpendResult;
      /** What the vault contract's own dry run (`check_spend`) says about the same payment. */
      contract: { ok: boolean; code: string | null };
      priceUsdc: string;
    }
  | { kind: "no_mandate"; payee: string };

/** One call to a pay-per-call endpoint, paying it through a Probarion vault when it answers 402. */
export async function fetchWithMandate(
  url: string,
  client: Client,
  fetchImpl: typeof fetch = fetch,
): Promise<CallResult> {
  const first = await fetchImpl(url);
  if (first.status !== 402) return { kind: "free", status: first.status, body: await first.json() };
  const offer = (await first.json()) as { quote?: unknown };
  // The quote text is the invoice. The JSON fields next to it are for people; the agent reads the text.
  const text = String(offer.quote ?? "");
  const quote = parseQuote(text);
  const priceUsdc = formatUsdc(quote.amount);

  const listed = await call(client, "list_mandates", {});
  if (listed.network !== quote.network) return { kind: "no_mandate", payee: quote.payee };
  const mandates = listed.mandates as MandateRow[];
  const forPayee = mandates.filter(
    (m) => m.payee_detail.type === "near" && m.payee_detail.account_id === quote.payee,
  );
  const mandate = forPayee.find((m) => m.status === "active") ?? forPayee[0];
  if (mandate === undefined) return { kind: "no_mandate", payee: quote.payee };

  const payment = {
    mandate_id: mandate.id,
    amount: priceUsdc,
    invoice_hash: quoteHash(text),
    ref: `402:${quote.id}`,
  };
  const spend = (await call(client, "request_spend", {
    ...payment,
    reasoning: `Pay-per-call: ${quote.resource} costs ${priceUsdc} USDC (quote ${quote.id}).`,
  })) as unknown as SpendResult;
  if (spend.status !== "paid" || spend.spend_id === null) {
    const check = await call(client, "check_spend", payment);
    return {
      kind: "refused",
      spend,
      contract: { ok: check.ok === true, code: (check.code as string | null) ?? null },
      priceUsdc,
    };
  }

  const second = await fetchImpl(url, {
    headers: {
      [PAYMENT_HEADERS.quote]: quote.id,
      [PAYMENT_HEADERS.vault]: String(listed.vault),
      [PAYMENT_HEADERS.spend]: String(spend.spend_id),
    },
  });
  return { kind: "paid", status: second.status, body: await second.json(), spend, priceUsdc };
}
