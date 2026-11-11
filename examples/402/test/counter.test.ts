// The seller's side of a counter: POST /counter, one per quote, a new quote at or above the floor, 409 below
// it, and a floor that no answer carries.
import type { SpendView } from "@probarion/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  COUNTER_PATH,
  createPaywall,
  PAYMENT_HEADERS,
  type PaymentReader,
  startPaywall,
} from "../src/paywall.js";
import { checkPricing, judgeCounter, parseQuote, QuoteError, quoteHash } from "../src/quote.js";
import { dataSha256 } from "../src/receipts.js";

const PAYEE = "seller.testnet";
const VAULT = "buyer.vaults.probarion.testnet";
const LIST = "12000";
const FLOOR = "9000";

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
    created_at_ns: (BigInt(Date.parse("2026-11-11T00:00:01Z")) * 1_000_000n).toString(),
    held_until_ns: null,
    memo: null,
    ...over,
  };
}

/** `floorUnits` null leaves the floor unset. */
async function start(reader: PaymentReader, floorUnits: string | null = FLOOR) {
  const p = await startPaywall({
    network: "testnet",
    payee: PAYEE,
    priceUnits: LIST,
    ...(floorUnits === null ? {} : { floorUnits }),
    path: "/forecast",
    data: (call) => ({ call, city: "Hanoi", forecast_c: [31] }),
    reader,
    now: () => new Date("2026-11-11T00:00:00Z"),
    newQuoteId: () => `q_${++ids}`,
  });
  close = p.close;
  return p;
}

const noSpend: PaymentReader = { isProbarionVault: async () => true, getSpend: async () => null };

interface Offer {
  quote: string;
  quote_hash: string;
  redeem_token: string;
  price_units: string;
  countered_from?: string;
  reason?: string;
}

async function firstOffer(url: string): Promise<Offer & { id: string }> {
  const r = await fetch(url);
  expect(r.status).toBe(402);
  const body = (await r.json()) as Offer;
  return { ...body, id: parseQuote(body.quote).id };
}

function counter(url: string, body: unknown) {
  return fetch(new URL(COUNTER_PATH, url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const counterOf = (o: Offer & { id: string }, amount: string) => ({
  quote_id: o.id,
  amount,
  redeem_token: o.redeem_token,
  reason: "My mandate pays at most 0.01 USDC a payment.",
});

describe("pricing", () => {
  it("refuses a floor above the list price, and judges a counter against the floor and the quote", () => {
    expect(() => checkPricing({ listUnits: "100", floorUnits: "101" })).toThrow(QuoteError);
    expect(() => checkPricing({ listUnits: "100", floorUnits: "0" })).toThrow(QuoteError);
    const p = checkPricing({ listUnits: LIST, floorUnits: FLOOR });
    expect(judgeCounter(p, LIST, "9000")).toBe("accept");
    expect(judgeCounter(p, LIST, "11999")).toBe("accept");
    expect(judgeCounter(p, LIST, "8999")).toBe("below_floor");
    expect(judgeCounter(p, LIST, LIST)).toBe("not_below_quote");
    expect(() =>
      createPaywall({
        network: "testnet",
        payee: PAYEE,
        priceUnits: "1",
        path: COUNTER_PATH,
        data: () => null,
        reader: noSpend,
      }),
    ).toThrow();
  });
});

describe("POST /counter", () => {
  it("takes a counter at or above the floor with a new quote: new id, same resource and payee, the countered price", async () => {
    const p = await start(noSpend);
    const o = await firstOffer(p.url);
    const r = await counter(p.url, counterOf(o, "10000"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as Offer;
    const q = parseQuote(body.quote);
    const first = parseQuote(o.quote);
    expect(body.countered_from).toBe(o.id);
    expect(q.id).not.toBe(first.id);
    expect(q).toMatchObject({ resource: first.resource, payee: PAYEE, amount: "10000" });
    expect(body.quote_hash).toBe(quoteHash(body.quote));
    expect(body.redeem_token).toMatch(/^[0-9a-f]{32}$/);
    expect(body.redeem_token).not.toBe(o.redeem_token);
    expect(p.counters()).toBe(1);
  });

  it("answers 409 below the floor, and no answer carries the floor", async () => {
    const p = await start(noSpend);
    const offerRes = await fetch(p.url);
    const offerText = await offerRes.text();
    const o = JSON.parse(offerText) as Offer;
    const r = await counter(p.url, counterOf({ ...o, id: parseQuote(o.quote).id }, "8999"));
    const text = await r.text();
    expect(r.status).toBe(409);
    expect(JSON.parse(text)).toEqual({ error: "counter_refused", reason: "below_floor" });
    // No key of either answer is about a floor, and no value or word in them is the floor's amount.
    const keys: string[] = [];
    const words: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") words.push(...v.split(/[\s:"(),;]+/));
      else if (typeof v === "number") words.push(String(v));
      else if (v !== null && typeof v === "object") {
        for (const [k, child] of Object.entries(v)) {
          keys.push(k);
          walk(child);
        }
      }
    };
    walk(JSON.parse(offerText));
    walk(JSON.parse(text));
    expect(keys.filter((k) => k.toLowerCase().includes("floor"))).toEqual([]);
    expect(words).not.toContain(FLOOR);
    expect(words).not.toContain("0.009");
  });

  it("allows one counter per quote, taken or not, and none on a counter's quote", async () => {
    const p = await start(noSpend);
    const a = await firstOffer(p.url);
    expect((await counter(p.url, counterOf(a, "10000"))).status).toBe(200);
    const again = await counter(p.url, counterOf(a, "11000"));
    expect(again.status).toBe(409);
    expect(((await again.json()) as Offer).reason).toBe("already_countered");

    const b = await firstOffer(p.url);
    expect((await counter(p.url, counterOf(b, "100"))).status).toBe(409);
    const retry = await counter(p.url, counterOf(b, "10000"));
    expect(((await retry.json()) as Offer).reason).toBe("already_countered");

    const c = await firstOffer(p.url);
    const taken = (await (await counter(p.url, counterOf(c, "10000"))).json()) as Offer;
    const second = { ...taken, id: parseQuote(taken.quote).id };
    const onCounter = await counter(p.url, counterOf(second, "9500"));
    expect(onCounter.status).toBe(409);
    expect(((await onCounter.json()) as Offer).reason).toBe("already_countered");
  });

  it("refuses a counter without the quote's redeem token, for an unknown quote, malformed, or not below the quote", async () => {
    const p = await start(noSpend);
    const o = await firstOffer(p.url);
    const reason = async (r: Response) => ((await r.json()) as Offer).reason;
    const badToken = await counter(p.url, {
      ...counterOf(o, "10000"),
      redeem_token: "0".repeat(32),
    });
    expect([badToken.status, await reason(badToken)]).toEqual([403, "bad_redeem_token"]);
    const unknown = await counter(p.url, { ...counterOf(o, "10000"), quote_id: "q_nope" });
    expect([unknown.status, await reason(unknown)]).toEqual([404, "unknown_quote"]);
    const extra = await counter(p.url, {
      ...counterOf(o, "10000"),
      payee: "near:attacker.testnet",
    });
    expect([extra.status, await reason(extra)]).toEqual([400, "unknown_field"]);
    const decimal = await counter(p.url, counterOf(o, "0.01"));
    expect([decimal.status, await reason(decimal)]).toEqual([400, "bad_amount"]);
    expect((await counter(p.url, "not json")).status).toBe(400);
    const huge = await counter(p.url, { ...counterOf(o, "10000"), reason: "x".repeat(5000) });
    expect([huge.status, await reason(huge)]).toEqual([413, "too_large"]);
    const tooMuch = await counter(p.url, counterOf(o, LIST));
    expect([tooMuch.status, await reason(tooMuch)]).toEqual([409, "not_below_quote"]);
  });

  it("with no floor set, refuses every counter", async () => {
    const p = await start(noSpend, null);
    const o = await firstOffer(p.url);
    const r = await counter(p.url, counterOf(o, "11999"));
    expect(r.status).toBe(409);
  });

  it("serves a countered quote for a spend of the countered price, with the data's sha256", async () => {
    let paid: SpendView | null = null;
    const p = await start({ isProbarionVault: async () => true, getSpend: async () => paid });
    const o = await firstOffer(p.url);
    const taken = (await (await counter(p.url, counterOf(o, "10000"))).json()) as Offer;
    const id = parseQuote(taken.quote).id;
    const redeem = () =>
      fetch(p.url, {
        headers: {
          [PAYMENT_HEADERS.quote]: id,
          [PAYMENT_HEADERS.redeem]: taken.redeem_token,
          [PAYMENT_HEADERS.vault]: VAULT,
          [PAYMENT_HEADERS.spend]: "1",
        },
      });
    // The list price paid against the countered quote's hash is not this quote's amount.
    paid = spend({ invoice_hash: taken.quote_hash, amount: LIST });
    expect(((await (await redeem()).json()) as Offer).reason).toBe("spend_does_not_pay_this_quote");
    paid = spend({ invoice_hash: taken.quote_hash, amount: "10000" });
    const ok = await redeem();
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      data: unknown;
      data_sha256: string;
      paid: { quote: string };
    };
    expect(body.paid.quote).toBe(id);
    expect(body.data_sha256).toBe(dataSha256(body.data));
  });
});
