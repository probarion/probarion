// The buying agent. It calls the endpoint; on a 402 it reads the quote, finds the mandate whose payee is the
// quote's payee, pays through the probarion-mcp tools, and calls again with the payment headers. It does not
// count uses or caps itself: the mandate is enforced by Probarion's rules and by the vault contract.
//
// When the quote is above the mandate's cap per payment, the agent counters once at that cap. It pays the new
// quote the seller gives for it, or walks away and asks for no payment at all. After a paid 200 it checks the
// data it bought and writes a receipt line.
//
// The payee is never taken from a quote: request_spend has no recipient field, so the vault pays the payee of
// the mandate. The quote's payee only picks which mandate to use, and a counter's quote must name the same one.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { formatUsdc, parseUsdc } from "@probarion/mcp";
import { forecastSchema } from "./forecast.js";
import { COUNTER_PATH, type CounterRequest, PAYMENT_HEADERS } from "./paywall.js";
import { parseQuote, type Quote, QuoteError, quoteHash } from "./quote.js";
import {
  appendReceipt,
  checkBought,
  type DataCheck,
  type DataSchema,
  FAILED_CHECK_NOTE,
  type Receipt,
} from "./receipts.js";

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
  /** The seq of the last entry this request wrote to the vault's signed ledger. */
  ledger_seq?: number | null;
  /** The body hash of this request's decision entry. */
  decision_hash?: string | null;
  note: string;
  earlier_spend?: { spend_id: number; status: string };
}

/** What happened to the price before any payment was asked for. Amounts are USDC smallest units. */
export interface Deal {
  resource: string;
  /** The first quote's id. */
  quoteId: string;
  listUnits: string;
  /** The cap per payment of the mandate the agent pays under. */
  limitUnits: string;
  mandateId: number;
  /** True when the agent countered the first quote (taken or not). */
  countered: boolean;
  /** The id of the quote the seller issued for the counter; null when there was none. */
  counteredQuoteId: string | null;
  /** What the agent asks the vault to pay: the list price, or the counter the seller took. */
  priceUnits: string;
}

export type CallResult =
  | { kind: "free"; status: number; body: unknown }
  | {
      kind: "paid";
      status: number;
      body: unknown;
      spend: SpendResult;
      priceUsdc: string;
      deal: Deal;
      /** The check of the data bought, after a 200; null for any other answer. */
      dataCheck: DataCheck | null;
      /** The receipt line written for a 200; null for any other answer. */
      receipt: Receipt | null;
    }
  | {
      kind: "refused";
      spend: SpendResult;
      /** What the vault contract's own dry run (`check_spend`) says about the same payment. */
      contract: { ok: boolean; code: string | null };
      priceUsdc: string;
      deal: Deal;
    }
  /** Held for an approver, or sent with no answer yet: not paid as far as the agent knows. Not sent again. */
  | {
      kind: "pending";
      spend: SpendResult;
      spendId: number | null;
      lastStatus: string;
      priceUsdc: string;
      deal: Deal;
    }
  | { kind: "failed"; spend: SpendResult; priceUsdc: string; deal: Deal }
  /** The quote was above the cap and the seller did not take the counter: nothing was asked of the vault. */
  | {
      kind: "walked_away";
      deal: Deal;
      listUsdc: string;
      counterUsdc: string;
      /** The seller's answer to the counter: its HTTP status and reason. */
      answer: { status: number; reason: string };
    }
  | { kind: "no_mandate"; payee: string };

export interface AgentOptions {
  fetchImpl?: typeof fetch;
  /** Waits between polls of a held or unconfirmed spend, and between redemption retries. */
  wait?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** How many times to read a held or unconfirmed spend before giving up on this call. Default 10. */
  polls?: number;
  /** The file a receipt line is appended to after each paid 200. Default: none is written. */
  receiptsPath?: string;
  /** The schema the bought data must fit. Default: the example's forecast. */
  schema?: DataSchema;
  /** The chain is the SDK's test double: receipts say so, and carry no explorer link. */
  testDouble?: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The mandate to pay this quote under, among the vault's mandates for the quote's NEAR payee. Live ones are
 * active, have uses left, have not expired and are bound to this server's key (when it is known). The lowest
 * id of the live ones whose cap per payment takes the amount; else the live one with the highest cap, for the
 * agent to counter at that cap; else the payee's first mandate, so that the refusal names the reason. Null when
 * no mandate pays the payee at all.
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
  const live = forPayee.filter(
    (m) =>
      m.status === "active" &&
      m.uses_left > 0 &&
      (m.expires_at === null || Date.parse(m.expires_at) > now.getTime()) &&
      (agentKey === null || m.agent_key === agentKey),
  );
  const cap = (m: MandateRow) => BigInt(parseUsdc(m.max_per_payment_usdc));
  const covering = live.find((m) => cap(m) >= BigInt(quote.amount));
  if (covering !== undefined) return covering;
  const highest = live.reduce<MandateRow | null>(
    (best, m) => (best === null || cap(m) > cap(best) ? m : best),
    null,
  );
  return highest ?? forPayee[0] ?? null;
}

/** A quote the agent can pay: its text (the invoice), and the token that redeems it. */
interface Payable {
  quote: Quote;
  text: string;
  token: string;
}

type CounterOutcome =
  | { kind: "taken"; payable: Payable }
  | { kind: "refused"; status: number; reason: string };

/**
 * Sends the one counter for the first quote at `amount`, and reads the seller's answer. A new quote is taken
 * only when its text parses, it has a new id, the first quote's resource, payee and network, the counter as
 * its amount, and an expiry still ahead.
 */
async function sendCounter(
  fetchImpl: typeof fetch,
  url: string,
  first: Payable,
  amount: string,
  reason: string,
  now: Date,
): Promise<CounterOutcome> {
  const request: CounterRequest = {
    quote_id: first.quote.id,
    amount,
    redeem_token: first.token,
    reason,
  };
  const r = await fetchImpl(new URL(COUNTER_PATH, url).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = (await r.json().catch(() => ({}))) as {
    reason?: unknown;
    quote?: unknown;
    redeem_token?: unknown;
  };
  if (r.status !== 200) {
    return {
      kind: "refused",
      status: r.status,
      reason: typeof body.reason === "string" ? body.reason.slice(0, 80) : `http_${r.status}`,
    };
  }
  const text = String(body.quote ?? "");
  let quote: Quote;
  try {
    quote = parseQuote(text);
  } catch (e) {
    if (e instanceof QuoteError) return { kind: "refused", status: r.status, reason: "bad_quote" };
    throw e;
  }
  const same =
    quote.id !== first.quote.id &&
    quote.resource === first.quote.resource &&
    quote.payee === first.quote.payee &&
    quote.network === first.quote.network &&
    quote.amount === amount &&
    Date.parse(quote.expiresAt) > now.getTime();
  if (!same) return { kind: "refused", status: r.status, reason: "quote_does_not_match_counter" };
  return { kind: "taken", payable: { quote, text, token: String(body.redeem_token ?? "") } };
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
  const firstText = String(offer.quote ?? "");
  const firstQuote = parseQuote(firstText);

  const listed = await call(client, "list_mandates", {});
  if (listed.network !== firstQuote.network) return { kind: "no_mandate", payee: firstQuote.payee };
  const agentKey = typeof listed.agent_key === "string" ? listed.agent_key : null;
  const mandate = pickMandate(listed.mandates as MandateRow[], firstQuote, agentKey, now());
  if (mandate === null) return { kind: "no_mandate", payee: firstQuote.payee };

  const limitUnits = parseUsdc(mandate.max_per_payment_usdc);
  const deal: Deal = {
    resource: firstQuote.resource,
    quoteId: firstQuote.id,
    listUnits: firstQuote.amount,
    limitUnits,
    mandateId: mandate.id,
    countered: false,
    counteredQuoteId: null,
    priceUnits: firstQuote.amount,
  };
  let payable: Payable = {
    quote: firstQuote,
    text: firstText,
    token: String(offer.redeem_token ?? ""),
  };
  if (BigInt(firstQuote.amount) > BigInt(limitUnits)) {
    // One counter, at the cap: the most this mandate pays in one payment.
    const limitUsdc = formatUsdc(limitUnits);
    deal.countered = true;
    const answer = await sendCounter(
      fetchImpl,
      url,
      payable,
      limitUnits,
      `My mandate pays at most ${limitUsdc} USDC a payment. I can pay ${limitUsdc}.`,
      now(),
    );
    if (answer.kind === "refused") {
      return {
        kind: "walked_away",
        deal,
        listUsdc: formatUsdc(firstQuote.amount),
        counterUsdc: limitUsdc,
        answer: { status: answer.status, reason: answer.reason },
      };
    }
    payable = answer.payable;
    deal.counteredQuoteId = payable.quote.id;
    deal.priceUnits = payable.quote.amount;
  }
  const { quote, text } = payable;
  const priceUsdc = formatUsdc(quote.amount);

  const payment = {
    mandate_id: mandate.id,
    amount: priceUsdc,
    invoice_hash: quoteHash(text),
    ref: `402:${quote.id}`,
  };
  const countered = deal.countered ? `, countered from ${formatUsdc(deal.listUnits)}` : "";
  const spend = (await call(client, "request_spend", {
    ...payment,
    reasoning: `Pay-per-call: ${quote.resource} costs ${priceUsdc} USDC (quote ${quote.id}${countered}).`,
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
        deal,
      };
    }
  } else if (spend.status === "failed") {
    return { kind: "failed", spend, priceUsdc, deal };
  }
  // Held for an approver, or sent with no answer: read the spend until it is paid, and send nothing again.
  for (let n = 0; status !== "paid" && spendId !== null && n < (options.polls ?? 10); n++) {
    await wait(3_000);
    const read = await call(client, "get_spend_status", { spend_id: spendId });
    status = String(read.status);
  }
  if (status !== "paid" || spendId === null) {
    return { kind: "pending", spend, spendId, lastStatus: status, priceUsdc, deal };
  }
  const paidId: number = spendId;

  // The RPC node the seller reads may lag behind the one that sent the spend: retry a few times.
  const redeem = () =>
    fetchImpl(url, {
      headers: {
        [PAYMENT_HEADERS.quote]: quote.id,
        [PAYMENT_HEADERS.redeem]: payable.token,
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
  if (second.status !== 200) {
    return {
      kind: "paid",
      status: second.status,
      body,
      spend,
      priceUsdc,
      deal,
      dataCheck: null,
      receipt: null,
    };
  }

  // The money has moved. The check below cannot undo that; it records what was bought.
  const dataCheck = checkBought(body, options.schema ?? forecastSchema);
  const receipt: Receipt = {
    v: 1,
    at: now().toISOString(),
    resource: quote.resource,
    seller: `near:${mandate.payee_detail.account_id ?? ""}`,
    network: quote.network,
    vault: String(listed.vault),
    mandate_id: mandate.id,
    quote_id: deal.quoteId,
    countered_quote_id: deal.counteredQuoteId,
    countered: deal.countered,
    list_price_usdc: formatUsdc(deal.listUnits),
    paid_usdc: priceUsdc,
    spend_id: paidId,
    tx_hash: spend.tx_hash,
    tx: options.testDouble === true ? null : spend.explorer,
    ledger_seq: spend.ledger_seq ?? null,
    decision_hash: spend.decision_hash ?? null,
    data_check: dataCheck,
    ...(dataCheck.ok ? {} : { note: FAILED_CHECK_NOTE }),
    ...(options.testDouble === true ? { test_double: true as const } : {}),
  };
  if (options.receiptsPath !== undefined) await appendReceipt(options.receiptsPath, receipt);
  return { kind: "paid", status: 200, body, spend, priceUsdc, deal, dataCheck, receipt };
}

/** A redemption the seller may accept on a later try: its RPC had not seen the spend yet, or it failed. */
function lagging(status: number, body: unknown): boolean {
  if (status >= 500) return true;
  return status === 402 && (body as { reason?: unknown }).reason === "spend_not_found";
}
