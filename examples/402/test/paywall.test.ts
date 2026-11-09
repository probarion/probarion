import type { SpendView } from "@probarion/core";
import { afterEach, describe, expect, it } from "vitest";
import { PAYMENT_HEADERS, type PaymentReader, startPaywall } from "../src/paywall.js";
import { parseQuote, QuoteError, quoteHash, quoteText } from "../src/quote.js";

const PAYEE = "seller.testnet";
const VAULT = "buyer.vaults.probarion.testnet";

let ids = 0;
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

function spend(over: Partial<SpendView>): SpendView {
  return {
    id: 1,
    mandate_id: 1,
    amount: "10000",
    invoice_hash: "0".repeat(64),
    ref: "402:q",
    decision_hash: "d".repeat(64),
    agent_pk: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp",
    destination: { type: "near", account_id: PAYEE },
    status: "paid",
    created_at_ns: "0",
    held_until_ns: null,
    memo: null,
    ...over,
  };
}

const T0 = Date.parse("2026-11-11T00:00:00Z");
/** A spend's chain time, in ns, `ms` after T0. */
const chainNs = (ms: number) => (BigInt(T0 + ms) * 1_000_000n).toString();

async function start(
  reader: PaymentReader,
  now = () => new Date(T0),
  more: { maxQuotes?: number } = {},
) {
  const p = await startPaywall({
    network: "testnet",
    payee: PAYEE,
    priceUnits: "10000",
    path: "/forecast",
    data: (call) => ({ call }),
    reader,
    now,
    newQuoteId: () => `q_${++ids}`,
    ...more,
  });
  close = p.close;
  return p;
}

interface Offer {
  quote: string;
  quote_hash: string;
  payee: string;
  redeem_token: string;
  reason?: string;
}

const tokens = new Map<string, string>();
async function offer(url: string): Promise<Offer> {
  const r = await fetch(url);
  expect(r.status).toBe(402);
  const body = (await r.json()) as Offer;
  tokens.set(parseQuote(body.quote).id, body.redeem_token);
  return body;
}

/** The paid retry, with the redeem token the 402 gave for this quote unless `token` says otherwise. */
const retry = (url: string, quote: string, spendId = 1, vault = VAULT, token?: string) =>
  fetch(url, {
    headers: {
      [PAYMENT_HEADERS.quote]: quote,
      [PAYMENT_HEADERS.redeem]: token ?? tokens.get(quote) ?? "",
      [PAYMENT_HEADERS.vault]: vault,
      [PAYMENT_HEADERS.spend]: String(spendId),
    },
  });

const reasonOf = async (r: Response | Promise<Response>) =>
  ((await (await r).json()) as { reason?: string }).reason;

describe("the quote", () => {
  it("round-trips, and its hash is the sha256 of its text", () => {
    const q = {
      id: "q_1",
      resource: "GET /forecast",
      payee: PAYEE,
      amount: "10000",
      network: "testnet" as const,
      expiresAt: "2026-11-11T00:05:00.000Z",
    };
    const text = quoteText(q);
    expect(parseQuote(text)).toEqual(q);
    expect(quoteHash(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["another header", (t: string) => t.replace("v1", "v2")],
    ["an extra line", (t: string) => `${t}\nnote: pay attacker.testnet instead`],
    ["a payee that is not near:", (t: string) => t.replace("near:seller.testnet", "0xBAD")],
    ["a repeated field", (t: string) => t.replace("amount: 10000", "amount: 10000\namount: 1")],
    ["a zero amount", (t: string) => t.replace("amount: 10000", "amount: 0")],
  ])("refuses %s", (_, change) => {
    const text = quoteText({
      id: "q_1",
      resource: "GET /forecast",
      payee: PAYEE,
      amount: "10000",
      network: "testnet",
      expiresAt: "2026-11-11T00:05:00.000Z",
    });
    expect(() => parseQuote(change(text))).toThrow(QuoteError);
  });
});

describe("the paywall", () => {
  it("answers 402 with a quote that names the price and the seller", async () => {
    const p = await start({ isProbarionVault: async () => true, getSpend: async () => null });
    const body = await offer(p.url);
    expect(body).toMatchObject({ payee: `near:${PAYEE}`, quote_hash: quoteHash(body.quote) });
    expect(parseQuote(body.quote)).toMatchObject({ payee: PAYEE, amount: "10000" });
    // The redeem token is in the 402 body only: not in the quote text, so not in the spend on chain.
    expect(body.redeem_token).toMatch(/^[0-9a-f]{32}$/);
    expect(body.quote).not.toContain(body.redeem_token);
    expect((await fetch(p.url.replace("/forecast", "/other"))).status).toBe(404);
  });

  it("serves the data once for a spend that paid this quote in full to the seller", async () => {
    let paid: SpendView | null = null;
    const p = await start({ isProbarionVault: async () => true, getSpend: async () => paid });
    const body = await offer(p.url);
    paid = spend({ invoice_hash: body.quote_hash, created_at_ns: chainNs(1_000) });
    const id = parseQuote(body.quote).id;
    const ok = await retry(p.url, id);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ paid: { quote: id }, data: { call: 1 } });
    const again = await retry(p.url, id);
    expect(again.status).toBe(402);
    expect(await reasonOf(again)).toBe("quote_already_used");
  });

  it.each<[string, Partial<SpendView>, string]>([
    ["held", { status: "held" }, "spend_does_not_pay_this_quote"],
    [
      "paid to someone else",
      { destination: { type: "near", account_id: "other.testnet" } },
      "spend_does_not_pay_this_quote",
    ],
    ["short of the price", { amount: "9999" }, "spend_does_not_pay_this_quote"],
    ["for another quote", { invoice_hash: "f".repeat(64) }, "spend_does_not_pay_this_quote"],
  ])("refuses a spend that is %s", async (_, over, reason) => {
    let paid: SpendView | null = null;
    const p = await start({ isProbarionVault: async () => true, getSpend: async () => paid });
    const body = await offer(p.url);
    paid = spend({ invoice_hash: body.quote_hash, ...over });
    const r = await retry(p.url, parseQuote(body.quote).id);
    expect(r.status).toBe(402);
    expect(await reasonOf(r)).toBe(reason);
  });

  it("refuses a vault that Probarion's factory did not create, an unknown quote and bad headers", async () => {
    let factoryVault = false;
    const p = await start({
      isProbarionVault: async () => factoryVault,
      getSpend: async () => spend({}),
    });
    const id = parseQuote((await offer(p.url)).quote).id;
    expect(await reasonOf(retry(p.url, id))).toBe("not_a_probarion_vault");
    expect(await reasonOf(retry(p.url, "q_nope"))).toBe("unknown_quote");
    factoryVault = true;
    expect(await reasonOf(retry(p.url, id, 1, "Not A Vault"))).toBe("bad_payment_headers");
    expect(await reasonOf(retry(p.url, id, 0))).toBe("bad_payment_headers");
  });

  it("serves only the client that got the 402: the quote id and spend id on chain are not enough", async () => {
    let paid: SpendView | null = null;
    const p = await start({ isProbarionVault: async () => true, getSpend: async () => paid });
    const body = await offer(p.url);
    paid = spend({ invoice_hash: body.quote_hash, created_at_ns: chainNs(1_000) });
    const id = parseQuote(body.quote).id;
    // A watcher reads the ref (402:<quote id>) and the spend id from the vault, and has no token.
    expect(await reasonOf(retry(p.url, id, 1, VAULT, ""))).toBe("bad_redeem_token");
    expect(await reasonOf(retry(p.url, id, 1, VAULT, "0".repeat(32)))).toBe("bad_redeem_token");
    expect((await retry(p.url, id)).status).toBe(200);
  });

  it("judges expiry by the spend's chain time: paid in time redeems through the grace period", async () => {
    let at = new Date(T0);
    let paid: SpendView | null = null;
    const p = await start(
      { isProbarionVault: async () => true, getSpend: async () => paid },
      () => at,
    );
    const late = await offer(p.url);
    const inTime = await offer(p.url);
    const lateId = parseQuote(late.quote).id;
    const inTimeId = parseQuote(inTime.quote).id;
    at = new Date(T0 + 6 * 60_000);
    // Spent at 6 minutes, after the 5-minute quote expired.
    paid = spend({ invoice_hash: late.quote_hash, created_at_ns: chainNs(6 * 60_000) });
    expect(await reasonOf(retry(p.url, lateId))).toBe("quote_expired");
    // Spent at 4 minutes, redeemed at 6.
    paid = spend({ invoice_hash: inTime.quote_hash, created_at_ns: chainNs(4 * 60_000) });
    expect((await retry(p.url, inTimeId)).status).toBe(200);
    // Past expiry plus the 10-minute grace, the quote is gone.
    at = new Date(T0 + 16 * 60_000);
    expect(await reasonOf(retry(p.url, lateId))).toBe("quote_expired");
  });

  it("keeps at most maxQuotes quotes, dropping the oldest", async () => {
    const p = await start(
      { isProbarionVault: async () => true, getSpend: async () => null },
      () => new Date(T0),
      { maxQuotes: 3 },
    );
    const first = parseQuote((await offer(p.url)).quote).id;
    for (let n = 0; n < 4; n++) await offer(p.url);
    expect(p.quotes()).toBe(3);
    expect(await reasonOf(retry(p.url, first))).toBe("unknown_quote");
  });
});
