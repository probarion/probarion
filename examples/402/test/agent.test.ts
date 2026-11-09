// The buyer's choices, with a stub MCP client and a stub endpoint: which mandate it pays under, and what it
// does with a payment that is held or has no answer yet.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";
import { fetchWithMandate, type MandateRow, pickMandate } from "../src/agent.js";
import { PAYMENT_HEADERS } from "../src/paywall.js";
import { type Quote, quoteText } from "../src/quote.js";

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

/** A stub MCP client: request_spend answers `spend`; get_spend_status walks through `statuses`. */
function stubClient(spend: Record<string, unknown>, statuses: string[]) {
  const calls: string[] = [];
  const answers: Record<string, () => unknown> = {
    list_mandates: () => ({
      vault: "buyer.vaults.probarion.testnet",
      network: "testnet",
      agent_key: KEY,
      mandates: [mandate({})],
    }),
    request_spend: () => spend,
    get_spend_status: () => ({ status: statuses.shift() ?? "held" }),
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

  it("a refusal that names an earlier paid spend under this ref redeems that spend", async () => {
    const { client } = stubClient(
      {
        status: "refused_by_code",
        spend_id: null,
        code: "invoice.duplicate",
        tx_hash: null,
        explorer: null,
        note: "",
        earlier_spend: { spend_id: 3, status: "paid" },
      },
      [],
    );
    const { fetchImpl, seen } = stubFetch();
    const r = await fetchWithMandate("http://seller/forecast", client, {
      fetchImpl,
      wait,
      now: () => NOW,
    });
    expect(r).toMatchObject({ kind: "paid", status: 200 });
    expect(seen[0]?.[PAYMENT_HEADERS.spend]).toBe("3");
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
