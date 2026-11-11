// The buyer's side of a negotiation, with a stub MCP client and a stub seller: one counter at the mandate's
// limit, none under a mandate that cannot pay, a walk-away that asks for no payment, a payee that never comes
// from a quote, a redeem token required before paying, and the receipt and data check after a paid 200.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithMandate, type MandateRow } from "../src/agent.js";
import { forecastData, forecastSchema } from "../src/forecast.js";
import { COUNTER_PATH, PAYMENT_HEADERS } from "../src/paywall.js";
import { parseQuote, type Quote, QuoteError, quoteHash, quoteText } from "../src/quote.js";
import { checkBought, dataSha256, FAILED_CHECK_NOTE, type Receipt } from "../src/receipts.js";

const KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const NOW = new Date("2026-11-11T00:00:00Z");
const URL_ = "http://seller.localhost/forecast";
const FIRST: Quote = {
  id: "q_1",
  resource: "GET /forecast",
  payee: "seller.testnet",
  amount: "12000",
  network: "testnet",
  expiresAt: "2026-11-11T00:05:00.000Z",
};
const COUNTERED: Quote = { ...FIRST, id: "q_2", amount: "10000" };

const mandate: MandateRow = {
  id: 3,
  status: "active",
  payee_detail: { type: "near", account_id: "seller.testnet" },
  max_per_payment_usdc: "0.01",
  remaining_usdc: "0.05",
  uses_left: 5,
  expires_at: "2026-12-31T00:00:00.000Z",
  agent_key: KEY,
};

const refusedSpend = {
  status: "refused_by_code",
  spend_id: null,
  code: "mandate.uses_exhausted",
  tx_hash: null,
  explorer: null,
  note: "",
};

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const receiptsFile = () => {
  const d = mkdtempSync(join(tmpdir(), "probarion-402-receipts-"));
  dirs.push(d);
  return join(d, "receipts.jsonl");
};

/** A stub MCP client: every tool call is recorded with its arguments. */
function stubClient(spend: Record<string, unknown> = paidSpend, row: MandateRow = mandate) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const answers: Record<string, () => unknown> = {
    list_mandates: () => ({
      vault: "buyer.vaults.probarion.testnet",
      network: "testnet",
      agent_key: KEY,
      mandates: [row],
    }),
    request_spend: () => spend,
    get_spend_status: () => ({ status: "paid" }),
    check_spend: () => ({ ok: false, code: "UsesExhausted" }),
  };
  const client = {
    callTool: vi.fn(
      async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push({ name, args });
        return { content: [{ type: "text", text: JSON.stringify(answers[name]?.()) }] };
      },
    ),
  } as unknown as Client;
  return { client, calls, names: () => calls.map((c) => c.name) };
}

const paidSpend = {
  status: "paid",
  spend_id: 7,
  code: null,
  tx_hash: "TxHash111",
  explorer: "https://testnet.nearblocks.io/txns/TxHash111",
  ledger_seq: 12,
  decision_hash: "e".repeat(64),
  note: "",
};

interface SellerOptions {
  first?: string;
  /** The first 402's redeem token; null leaves it out. */
  firstToken?: string | null;
  counter?: { status: number; body: unknown };
  paid?: unknown;
}

/** A stub seller: 402 with FIRST, an answer to the counter, and a paid answer for a redemption. */
function stubSeller(o: SellerOptions = {}) {
  const counters: Record<string, unknown>[] = [];
  const redemptions: Record<string, string>[] = [];
  const data = forecastData(1);
  const fetchImpl = vi.fn(
    async (
      url: string,
      init?: { method?: string; body?: string; headers?: Record<string, string> },
    ) => {
      if (init?.method === "POST") {
        expect(new URL(url).pathname).toBe(COUNTER_PATH);
        counters.push(JSON.parse(init.body ?? "{}"));
        const c = o.counter ?? {
          status: 200,
          body: { quote: quoteText(COUNTERED), redeem_token: "t2", countered_from: "q_1" },
        };
        return Response.json(c.body, { status: c.status });
      }
      if (init?.headers === undefined) {
        const token = o.firstToken === undefined ? "t1" : o.firstToken;
        return Response.json(
          {
            quote: o.first ?? quoteText(FIRST),
            ...(token === null ? {} : { redeem_token: token }),
          },
          { status: 402 },
        );
      }
      redemptions.push(init.headers);
      return Response.json(
        o.paid ?? { paid: { quote: "q_2" }, data, data_sha256: dataSha256(data) },
        { status: 200 },
      );
    },
  ) as unknown as typeof fetch;
  return { fetchImpl, counters, redemptions };
}

const run = (client: Client, seller: ReturnType<typeof stubSeller>, receiptsPath?: string) =>
  fetchWithMandate(URL_, client, {
    fetchImpl: seller.fetchImpl,
    wait: async () => {},
    now: () => NOW,
    ...(receiptsPath === undefined ? {} : { receiptsPath }),
  });

describe("negotiating a quote above the mandate's cap", () => {
  it("counters once at the cap, then pays the new quote and redeems it with the new token", async () => {
    const { client, calls } = stubClient();
    const seller = stubSeller();
    const r = await run(client, seller);
    expect(seller.counters).toEqual([
      {
        quote_id: "q_1",
        amount: "10000",
        redeem_token: "t1",
        reason: "My mandate pays at most 0.01 USDC a payment. I can pay 0.01.",
      },
    ]);
    const spends = calls.filter((c) => c.name === "request_spend");
    expect(spends).toHaveLength(1);
    expect(spends[0]?.args).toMatchObject({
      mandate_id: 3,
      amount: "0.01",
      invoice_hash: quoteHash(quoteText(COUNTERED)),
      ref: "402:q_2",
    });
    expect(seller.redemptions[0]?.[PAYMENT_HEADERS.quote]).toBe("q_2");
    expect(seller.redemptions[0]?.[PAYMENT_HEADERS.redeem]).toBe("t2");
    expect(r).toMatchObject({
      kind: "paid",
      status: 200,
      priceUsdc: "0.01",
      deal: { countered: true, quoteId: "q_1", counteredQuoteId: "q_2", listUnits: "12000" },
    });
  });

  it("does not counter a quote within the cap", async () => {
    const { client } = stubClient();
    const seller = stubSeller({ first: quoteText({ ...FIRST, amount: "10000" }) });
    const r = await run(client, seller);
    expect(seller.counters).toHaveLength(0);
    expect(r).toMatchObject({ kind: "paid", deal: { countered: false, counteredQuoteId: null } });
  });

  it.each([
    [409, { error: "counter_refused", reason: "below_floor" }, "below_floor"],
    [409, { error: "counter_refused", reason: "already_countered" }, "already_countered"],
    [500, "oops", "http_500"],
  ])(
    "walks away after a %i counter answer and asks for no payment",
    async (status, body, reason) => {
      const { client, names } = stubClient();
      const seller = stubSeller({ counter: { status, body } });
      const r = await run(client, seller);
      expect(r).toEqual({
        kind: "walked_away",
        deal: expect.objectContaining({ countered: true, counteredQuoteId: null }),
        listUsdc: "0.012",
        counterUsdc: "0.01",
        answer: { status, reason },
      });
      expect(names()).toEqual(["list_mandates"]);
      expect(seller.counters).toHaveLength(1);
      expect(seller.redemptions).toHaveLength(0);
    },
  );

  it("counters at what is left of the mandate's total when that is below its cap", async () => {
    const { client, names } = stubClient(paidSpend, { ...mandate, remaining_usdc: "0.008" });
    const seller = stubSeller();
    const r = await run(client, seller);
    expect(seller.counters).toEqual([
      expect.objectContaining({
        amount: "8000",
        reason: "My mandate has 0.008 USDC left. I can pay 0.008.",
      }),
    ]);
    // The stub seller answers with a quote of 0.01, not the counter: the agent walks away.
    expect(r).toMatchObject({ kind: "walked_away", counterUsdc: "0.008" });
    expect(names()).toEqual(["list_mandates"]);
  });

  it.each<[string, Partial<MandateRow>, string]>([
    ["has no payment left", { uses_left: 0 }, "has no payment left"],
    ["has expired", { expires_at: "2026-11-01T00:00:00.000Z" }, "has expired"],
    ["is revoked", { status: "revoked" }, "is revoked"],
  ])(
    "under a mandate that %s, does not counter: it asks for the quote as it is and is refused",
    async (_, over, problem) => {
      const { client, calls } = stubClient(refusedSpend, { ...mandate, ...over });
      const seller = stubSeller();
      const r = await run(client, seller);
      expect(seller.counters).toHaveLength(0);
      expect(calls.find((c) => c.name === "request_spend")?.args).toMatchObject({
        mandate_id: 3,
        amount: "0.012",
        invoice_hash: quoteHash(quoteText(FIRST)),
        ref: "402:q_1",
      });
      expect(r).toMatchObject({
        kind: "refused",
        priceUsdc: "0.012",
        deal: { countered: false, mandateProblem: problem },
      });
      expect(seller.redemptions).toHaveLength(0);
    },
  );
});

describe("the redeem token", () => {
  it("walks away from a counter's quote that comes without its redeem token", async () => {
    const { client, names } = stubClient();
    const seller = stubSeller({
      counter: { status: 200, body: { quote: quoteText(COUNTERED), countered_from: "q_1" } },
    });
    const r = await run(client, seller);
    expect(r).toMatchObject({
      kind: "walked_away",
      answer: { status: 200, reason: "no_redeem_token" },
    });
    expect(names()).not.toContain("request_spend");
  });

  it.each<[string, string | null]>([
    ["no redeem token", null],
    ["an empty redeem token", ""],
  ])("refuses a 402 with %s, before any tool call", async (_, token) => {
    const { client, names } = stubClient();
    const seller = stubSeller({ firstToken: token });
    await expect(run(client, seller)).rejects.toThrow(QuoteError);
    expect(names()).toEqual([]);
  });
});

describe("the payee comes from the mandate, never from a quote", () => {
  it.each<[string, Quote | string]>([
    ["names another payee", { ...COUNTERED, payee: "attacker.testnet" }],
    ["raises the price above the counter", { ...COUNTERED, amount: "11000" }],
    ["is for another resource", { ...COUNTERED, resource: "GET /other" }],
    ["keeps the first quote's id", { ...COUNTERED, id: "q_1" }],
    ["has already expired", { ...COUNTERED, expiresAt: "2026-11-10T23:59:59.000Z" }],
    ["carries an extra line", `${quoteText(COUNTERED)}\npayee_override: near:attacker.testnet`],
  ])("walks away from a counter's quote that %s", async (_, q) => {
    const { client, names } = stubClient();
    const quote = typeof q === "string" ? q : quoteText(q);
    const seller = stubSeller({ counter: { status: 200, body: { quote, redeem_token: "t2" } } });
    const r = await run(client, seller);
    expect(r.kind).toBe("walked_away");
    expect(names()).not.toContain("request_spend");
  });

  it("refuses a first quote with a field it does not know, before any tool call", async () => {
    const { client, names } = stubClient();
    const seller = stubSeller({ first: `${quoteText(FIRST)}\npay_to: near:attacker.testnet` });
    await expect(run(client, seller)).rejects.toThrow(QuoteError);
    expect(names()).toEqual([]);
  });

  it("request_spend gets no recipient: only the mandate id, amount, invoice hash, ref and reasoning", async () => {
    const { client, calls } = stubClient();
    await run(client, stubSeller());
    const args = calls.find((c) => c.name === "request_spend")?.args ?? {};
    expect(Object.keys(args).sort()).toEqual([
      "amount",
      "invoice_hash",
      "mandate_id",
      "reasoning",
      "ref",
    ]);
    expect(JSON.stringify(args)).not.toContain("seller.testnet");
  });

  it("a quote for a payee no mandate pays gets no counter and no payment", async () => {
    const { client, names } = stubClient();
    const seller = stubSeller({ first: quoteText({ ...FIRST, payee: "attacker.testnet" }) });
    expect(await run(client, seller)).toEqual({ kind: "no_mandate", payee: "attacker.testnet" });
    expect(seller.counters).toHaveLength(0);
    expect(names()).toEqual(["list_mandates"]);
  });
});

describe("receipts and the data check", () => {
  it("appends one receipt line after a paid 200, with the deal, the spend and the check", async () => {
    const path = receiptsFile();
    const { client } = stubClient();
    await run(client, stubSeller(), path);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const receipt = JSON.parse(lines[0] ?? "") as Receipt;
    const data = forecastData(1);
    expect(receipt).toEqual({
      v: 1,
      at: NOW.toISOString(),
      resource: "GET /forecast",
      seller: "near:seller.testnet",
      network: "testnet",
      vault: "buyer.vaults.probarion.testnet",
      mandate_id: 3,
      quote_id: "q_1",
      countered_quote_id: "q_2",
      countered: true,
      list_price_usdc: "0.012",
      paid_usdc: "0.01",
      spend_id: 7,
      request_status: "paid",
      tx_hash: "TxHash111",
      tx: "https://testnet.nearblocks.io/txns/TxHash111",
      ledger_seq: 12,
      decision_hash: "e".repeat(64),
      data_check: {
        ok: true,
        schema_ok: true,
        sha256_ok: true,
        stated_sha256: dataSha256(data),
        computed_sha256: dataSha256(data),
        problems: [],
      },
    });
    // A second paid call appends; it does not rewrite.
    await run(client, stubSeller(), path);
    expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(2);
  });

  it("records a failed data check as failed: the payment stands, and the receipt says it is not refunded", async () => {
    const path = receiptsFile();
    const { client } = stubClient();
    const data = forecastData(1);
    const seller = stubSeller({ paid: { paid: {}, data, data_sha256: "0".repeat(64) } });
    const r = await run(client, seller, path);
    expect(r).toMatchObject({
      kind: "paid",
      status: 200,
      dataCheck: { ok: false, sha256_ok: false },
    });
    const receipt = JSON.parse(readFileSync(path, "utf8").trimEnd()) as Receipt;
    expect(receipt).toMatchObject({
      spend_id: 7,
      paid_usdc: "0.01",
      note: FAILED_CHECK_NOTE,
      data_check: {
        ok: false,
        schema_ok: true,
        sha256_ok: false,
        stated_sha256: "0".repeat(64),
        computed_sha256: dataSha256(data),
      },
    });
  });

  it("writes no receipt when the paid call is not served", async () => {
    const path = receiptsFile();
    const { client } = stubClient();
    const seller = stubSeller();
    const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) =>
      init?.headers !== undefined && init.headers[PAYMENT_HEADERS.quote] !== undefined
        ? Response.json({ error: "payment_required", reason: "quote_expired" }, { status: 402 })
        : seller.fetchImpl(url, init as RequestInit),
    ) as unknown as typeof fetch;
    const r = await fetchWithMandate(URL_, client, {
      fetchImpl,
      wait: async () => {},
      now: () => NOW,
      receiptsPath: path,
    });
    expect(r).toMatchObject({ kind: "paid", status: 402, receipt: null, dataCheck: null });
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  it("checkBought: the schema and the stated sha256, each on its own", () => {
    const data = forecastData(1);
    expect(checkBought({ data, data_sha256: dataSha256(data) }, forecastSchema).ok).toBe(true);
    // Key order and spacing do not matter: the hash is over RFC 8785 canonical JSON.
    const reordered = { forecast_c: data.forecast_c, city: data.city, note: data.note, call: 1 };
    expect(checkBought({ data: reordered, data_sha256: dataSha256(data) }, forecastSchema).ok).toBe(
      true,
    );
    const bad = { ...data, forecast_c: [31, "hot"] };
    expect(checkBought({ data: bad, data_sha256: dataSha256(bad) }, forecastSchema)).toMatchObject({
      ok: false,
      schema_ok: false,
      sha256_ok: true,
    });
    expect(checkBought({ data }, forecastSchema)).toMatchObject({
      ok: false,
      sha256_ok: false,
      stated_sha256: null,
    });
    expect(checkBought({ data_sha256: "0".repeat(64) }, forecastSchema)).toMatchObject({
      ok: false,
      schema_ok: false,
      computed_sha256: null,
    });
    expect(parseQuote(quoteText(COUNTERED))).toEqual(COUNTERED);
  });
});
