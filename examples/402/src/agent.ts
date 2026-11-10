// The buying agent. It calls the endpoint; on a 402 it reads the quote, finds the mandate whose payee is the
// quote's payee, pays through the probarion-mcp tools, and calls again with the payment headers. It does not
// count uses or caps itself: the mandate is enforced by Probarion's rules and by the vault contract.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { formatUsdc, parseUsdc } from "@probarion/mcp";
import { PAYMENT_HEADERS } from "./paywall.js";
import { parseQuote, type Quote, quoteHash } from "./quote.js";

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

/** A row of list_mandates, as far as the agent reads it. */
export interface MandateRow {
  id: number;
  status: string;
  payee_detail: { type: string; account_id?: string };
  max_per_payment_usdc: string;
  uses_left: number;
  expires_at: string | null;
  agent_key: string;
}

export interface SpendResult {
  status: string;
  spend_id: number | null;
  code: string | null;
  tx_hash: string | null;
  explorer: string | null;
  note: string;
  earlier_spend?: { spend_id: number; status: string };
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
  /** Held for an approver, or sent with no answer yet: not paid as far as the agent knows. Not sent again. */
  | {
      kind: "pending";
      spend: SpendResult;
      spendId: number | null;
      lastStatus: string;
      priceUsdc: string;
    }
  | { kind: "failed"; spend: SpendResult; priceUsdc: string }
  | { kind: "no_mandate"; payee: string };

export interface AgentOptions {
  fetchImpl?: typeof fetch;
  /** Waits between polls of a held or unconfirmed spend, and between redemption retries. */
  wait?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** How many times to read a held or unconfirmed spend before giving up on this call. Default 10. */
  polls?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The mandate to pay this quote under: the lowest id among the vault's mandates for the quote's NEAR payee
 * that this server's key may use and that can still take the amount. When none can, the first one for the
 * payee, so that the refusal names the reason; null when no mandate pays the payee at all.
 */
export function pickMandate(
  mandates: readonly MandateRow[],
  quote: Quote,
  agentKey: string | null,
  now: Date,
): MandateRow | null {
  const forPayee = mandates
    .filter((m) => m.payee_detail.type === "near" && m.payee_detail.account_id === quote.payee)
    .sort((a, b) => a.id - b.id);
  const usable = forPayee.find(
    (m) =>
      m.status === "active" &&
      m.uses_left > 0 &&
      (m.expires_at === null || Date.parse(m.expires_at) > now.getTime()) &&
      BigInt(parseUsdc(m.max_per_payment_usdc)) >= BigInt(quote.amount) &&
      (agentKey === null || m.agent_key === agentKey),
  );
  return usable ?? forPayee[0] ?? null;
}

/** One call to a pay-per-call endpoint, paying it through a Probarion vault when it answers 402. */
export async function fetchWithMandate(
  url: string,
  client: Client,
  options: AgentOptions = {},
): Promise<CallResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? sleep;
  const now = options.now ?? (() => new Date());
  const first = await fetchImpl(url);
  if (first.status !== 402) return { kind: "free", status: first.status, body: await first.json() };
  const offer = (await first.json()) as { quote?: unknown; redeem_token?: unknown };
  // The quote text is the invoice. The JSON fields next to it are for people; the agent reads the text.
  const text = String(offer.quote ?? "");
  const quote = parseQuote(text);
  const priceUsdc = formatUsdc(quote.amount);

  const listed = await call(client, "list_mandates", {});
  if (listed.network !== quote.network) return { kind: "no_mandate", payee: quote.payee };
  const agentKey = typeof listed.agent_key === "string" ? listed.agent_key : null;
  const mandate = pickMandate(listed.mandates as MandateRow[], quote, agentKey, now());
  if (mandate === null) return { kind: "no_mandate", payee: quote.payee };

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

  const spendId = spend.spend_id ?? spend.earlier_spend?.spend_id ?? null;
  let status = spend.earlier_spend?.status ?? spend.status;
  if (spend.status === "refused_by_code" || spend.status === "refused_by_contract") {
    if (spend.earlier_spend === undefined) {
      const check = await call(client, "check_spend", payment);
      return {
        kind: "refused",
        spend,
        contract: { ok: check.ok === true, code: (check.code as string | null) ?? null },
        priceUsdc,
      };
    }
  } else if (spend.status === "failed") {
    return { kind: "failed", spend, priceUsdc };
  }
  // Held for an approver, or sent with no answer: read the spend until it is paid, and send nothing again.
  for (let n = 0; status !== "paid" && spendId !== null && n < (options.polls ?? 10); n++) {
    await wait(3_000);
    const read = await call(client, "get_spend_status", { spend_id: spendId });
    status = String(read.status);
  }
  if (status !== "paid" || spendId === null) {
    return { kind: "pending", spend, spendId, lastStatus: status, priceUsdc };
  }
  const paidId: number = spendId;

  // The RPC node the seller reads may lag behind the one that sent the spend: retry a few times.
  const redeem = () =>
    fetchImpl(url, {
      headers: {
        [PAYMENT_HEADERS.quote]: quote.id,
        [PAYMENT_HEADERS.redeem]: String(offer.redeem_token ?? ""),
        [PAYMENT_HEADERS.vault]: String(listed.vault),
        [PAYMENT_HEADERS.spend]: String(paidId),
      },
    });
  let second = await redeem();
  let body: unknown = await second.json();
  for (let n = 0; n < 3 && lagging(second.status, body); n++) {
    await wait(2_000);
    second = await redeem();
    body = await second.json();
  }
  return { kind: "paid", status: second.status, body, spend, priceUsdc };
}

/** A redemption the seller may accept on a later try: its RPC had not seen the spend yet, or it failed. */
function lagging(status: number, body: unknown): boolean {
  if (status >= 500) return true;
  return status === 402 && (body as { reason?: unknown }).reason === "spend_not_found";
}
