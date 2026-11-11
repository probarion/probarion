// The buyer's choices, with a stub MCP client and a stub endpoint: which mandate it pays under, and what it
// does with a payment that is held or has no answer yet.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";
import {
  fetchWithMandate,
  type MandateRow,
  payLimit,
  pickMandate,
  whyNotLive,
} from "../src/agent.js";
import { PAYMENT_HEADERS } from "../src/paywall.js";
import { type Quote, quoteHash, quoteText } from "../src/quote.js";

const KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const NOW = new Date("2026-11-11T00:00:00Z");
const QUOTE: Quote = {
  id: "q_1",
  resource: "GET /forecast",
  payee: "seller.testnet",
  amount: "10000",
  network: "testnet",
  expiresAt: "2026-11-11T00:05:00.000Z",
};

function mandate(over: Partial<MandateRow>): MandateRow {
  return {
    id: 1,
    status: "active",
    payee_detail: { type: "near", account_id: "seller.testnet" },
    max_per_payment_usdc: "0.01",
    remaining_usdc: "0.20",
    uses_left: 20,
    expires_at: "2026-12-31T00:00:00.000Z",
    agent_key: KEY,
    ...over,
  };
}

describe("pickMandate", () => {
  it("skips mandates that cannot take the payment, and takes the lowest id of the rest", () => {
    const rows = [
      mandate({ id: 1, expires_at: "2026-11-01T00:00:00.000Z" }),
      mandate({ id: 2, uses_left: 0 }),
      mandate({ id: 3, max_per_payment_usdc: "0.005" }),
      mandate({ id: 4, agent_key: "ed25519:other" }),
      mandate({ id: 5, status: "revoked" }),
      mandate({ id: 7 }),
      mandate({ id: 6 }),
      mandate({ id: 8, payee_detail: { type: "near", account_id: "other.testnet" } }),
    ];
    expect(pickMandate(rows, QUOTE, KEY, NOW)?.id).toBe(6);
  });

  it("with no live mandate covering the price, takes the live one with the highest cap, the lowest id on a tie", () => {
    const quote = { ...QUOTE, amount: "10000" };
    const rows = [
      mandate({ id: 1, max_per_payment_usdc: "0.02", uses_left: 0 }),
      mandate({ id: 3, max_per_payment_usdc: "0.005" }),
      mandate({ id: 10, max_per_payment_usdc: "0.008" }),
      mandate({ id: 9, max_per_payment_usdc: "0.008" }),
    ];
    expect(pickMandate(rows, quote, KEY, NOW)?.id).toBe(9);
  });

  it("reads a mandate's limit as the lesser of its cap per payment and what is left of its total", () => {
    const covering = [
      mandate({ id: 5, max_per_payment_usdc: "0.02", remaining_usdc: "0.005" }),
      mandate({ id: 6, max_per_payment_usdc: "0.01", remaining_usdc: "1.00" }),
    ];
    expect(pickMandate(covering, QUOTE, KEY, NOW)?.id).toBe(6);
    const short = [
      mandate({ id: 2, max_per_payment_usdc: "0.02", remaining_usdc: "0.004" }),
      mandate({ id: 4, max_per_payment_usdc: "0.006", remaining_usdc: "1.00" }),
    ];
    expect(pickMandate(short, QUOTE, KEY, NOW)?.id).toBe(4);
    expect(payLimit(mandate({ max_per_payment_usdc: "0.02", remaining_usdc: "0.004" }))).toBe(
      4000n,
    );
  });

  it("names why a mandate cannot pay", () => {
    const why = (over: Partial<MandateRow>) => whyNotLive(mandate(over), KEY, NOW);
    expect(why({})).toBeNull();
    expect(why({ status: "revoked" })).toBe("is revoked");
    expect(why({ uses_left: 0 })).toBe("has no payment left");
    expect(why({ expires_at: "2026-11-01T00:00:00.000Z" })).toBe("has expired");
    expect(why({ agent_key: "ed25519:other" })).toBe("is bound to another agent key");
    expect(why({ remaining_usdc: "0.00" })).toBe("has nothing left of its total");
  });

  it("falls back to the payee's first mandate so the refusal names why, and to null for another payee", () => {
    expect(pickMandate([mandate({ id: 2, uses_left: 0 })], QUOTE, KEY, NOW)?.id).toBe(2);
    expect(
      pickMandate(
        [mandate({ payee_detail: { type: "near", account_id: "x.testnet" } })],
        QUOTE,
        KEY,
        NOW,
      ),
    ).toBeNull();
  });
});

/**
 * A stub MCP client: request_spend answers `spend`; get_spend_status answers `read`, with a status from
 * `statuses` while it has one.
 */
function stubClient(
  spend: Record<string, unknown>,
  statuses: string[],
  read: Record<string, unknown> = {},
) {
  const calls: string[] = [];
  const answers: Record<string, () => unknown> = {
    list_mandates: () => ({
      vault: "buyer.vaults.probarion.testnet",
      network: "testnet",
      agent_key: KEY,
      mandates: [mandate({})],
    }),
    request_spend: () => spend,
    get_spend_status: () => ({ ...read, status: statuses.shift() ?? read.status ?? "held" }),
    check_spend: () => ({ ok: false, code: "UsesExhausted" }),
  };
  const client = {
    callTool: vi.fn(async ({ name }: { name: string }) => {
      calls.push(name);
      return { content: [{ type: "text", text: JSON.stringify(answers[name]?.()) }] };
    }),
  } as unknown as Client;
  return { client, calls };
}

/** A stub endpoint: 402 with a quote and a token, then 200 for a retry that carries the token. */
function stubFetch() {
  const seen: Record<string, string>[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
    if (init?.headers === undefined) {
      return Response.json({ quote: quoteText(QUOTE), redeem_token: "t0ken" }, { status: 402 });
    }
    seen.push(init.headers);
    return Response.json({ data: "ok" }, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const wait = vi.fn(async () => {});

describe("fetchWithMandate", () => {
  it("reads a held spend until it is paid, then redeems it once with the redeem token", async () => {
    const { client, calls } = stubClient(
      { status: "held", spend_id: 4, code: null, tx_hash: null, explorer: null, note: "" },
      ["held", "paid"],
    );
    const { fetchImpl, seen } = stubFetch();
    const r = await fetchWithMandate("http://seller/forecast", client, {
      fetchImpl,
      wait,
      now: () => NOW,
    });
    expect(r).toMatchObject({ kind: "paid", status: 200 });
    expect(calls.filter((c) => c === "request_spend")).toHaveLength(1);
    expect(calls.filter((c) => c === "get_spend_status")).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[PAYMENT_HEADERS.redeem]).toBe("t0ken");
    expect(seen[0]?.[PAYMENT_HEADERS.spend]).toBe("4");
  });

  it("an unconfirmed payment with no spend found is pending: not redeemed, and not paid again", async () => {
    const { client, calls } = stubClient(
      {
        status: "unconfirmed",
        spend_id: null,
        code: null,
        tx_hash: null,
        explorer: null,
        note: "",
      },
      [],
    );
    const { fetchImpl, seen } = stubFetch();
    const r = await fetchWithMandate("http://seller/forecast", client, {
      fetchImpl,
      wait,
      now: () => NOW,
    });
    expect(r).toMatchObject({ kind: "pending", spendId: null, lastStatus: "unconfirmed" });
    expect(calls.filter((c) => c === "request_spend")).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });

  const duplicate = {
    status: "refused_by_code",
    spend_id: null,
    code: "invoice.duplicate",
    tx_hash: null,
    explorer: null,
    ledger_seq: 9,
    decision_hash: "e".repeat(64),
    note: "",
    earlier_spend: { spend_id: 3, status: "paid" },
  };
  /** Spend 3 as get_spend_status shows it: it pays QUOTE under mandate 1. */
  const spend3 = {
    spend_id: 3,
    status: "paid",
    mandate_id: 1,
    amount_usdc: "0.01",
    invoice_hash: quoteHash(quoteText(QUOTE)),
    ref: "402:q_1",
  };

  it("a refusal that names an earlier paid spend of this very quote redeems that spend, and the receipt says so", async () => {
    const { client, calls } = stubClient(duplicate, [], spend3);
    const { fetchImpl, seen } = stubFetch();
    const r = await fetchWithMandate("http://seller/forecast", client, {
      fetchImpl,
      wait,
      now: () => NOW,
    });
    expect(r).toMatchObject({
      kind: "paid",
      status: 200,
      receipt: { spend_id: 3, request_status: "refused_by_code", tx_hash: null, ledger_seq: 9 },
    });
    expect(calls).toContain("get_spend_status");
    expect(calls).not.toContain("check_spend");
    expect(seen[0]?.[PAYMENT_HEADERS.spend]).toBe("3");
  });

  it.each<[string, Record<string, unknown>]>([
    ["another quote's invoice hash", { invoice_hash: "f".repeat(64) }],
    ["another amount", { amount_usdc: "0.008" }],
    ["another mandate", { mandate_id: 2 }],
    ["another ref", { ref: "402:q_0" }],
  ])(
    "an earlier spend under this ref with %s is a refusal: not redeemed, no receipt",
    async (_, over) => {
      const { client, calls } = stubClient(duplicate, [], { ...spend3, ...over });
      const { fetchImpl, seen } = stubFetch();
      const r = await fetchWithMandate("http://seller/forecast", client, {
        fetchImpl,
        wait,
        now: () => NOW,
      });
      expect(r).toMatchObject({ kind: "refused", spend: { code: "invoice.duplicate" } });
      expect(calls).toContain("check_spend");
      expect(seen).toHaveLength(0);
    },
  );

  const unconfirmed = {
    status: "unconfirmed",
    spend_id: null,
    code: "TxOutcomeUnknown",
    tx_hash: "TxUnknown1",
    explorer: null,
    note: "",
    earlier_spend: { spend_id: 3, status: "pending" },
  };

  it("a send with no answer that names a spend of this very quote reads that spend until paid, then redeems it", async () => {
    const { client, calls } = stubClient(unconfirmed, ["pending", "paid"], spend3);
    const { fetchImpl, seen } = stubFetch();
    const r = await fetchWithMandate("http://seller/forecast", client, {
      fetchImpl,
      wait,
      now: () => NOW,
    });
    expect(r).toMatchObject({
      kind: "paid",
      status: 200,
      receipt: { request_status: "unconfirmed" },
    });
    expect(calls.filter((c) => c === "request_spend")).toHaveLength(1);
    expect(seen[0]?.[PAYMENT_HEADERS.spend]).toBe("3");
  });

  it("a send with no answer that names a spend of another quote is pending: nothing redeemed", async () => {
    const { client, calls } = stubClient(unconfirmed, [], {
      ...spend3,
      invoice_hash: "f".repeat(64),
    });
    const { fetchImpl, seen } = stubFetch();
    const r = await fetchWithMandate("http://seller/forecast", client, {
      fetchImpl,
      wait,
      now: () => NOW,
    });
    expect(r).toMatchObject({ kind: "pending", spendId: null, lastStatus: "unconfirmed" });
    expect(calls.filter((c) => c === "request_spend")).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });

  it("a plain refusal asks the contract's dry run and redeems nothing", async () => {
    const { client, calls } = stubClient(
      {
        status: "refused_by_code",
        spend_id: null,
        code: "mandate.uses_exhausted",
        tx_hash: null,
        explorer: null,
        note: "",
      },
      [],
    );
    const { fetchImpl, seen } = stubFetch();
    const r = await fetchWithMandate("http://seller/forecast", client, {
      fetchImpl,
      wait,
      now: () => NOW,
    });
    expect(r).toMatchObject({ kind: "refused", contract: { ok: false, code: "UsesExhausted" } });
    expect(calls).toContain("check_spend");
    expect(seen).toHaveLength(0);
  });
});
