import { describe, expect, it } from "vitest";
import {
  checkSpendArgs,
  expiryDate,
  fill,
  formatUsdc,
  LIVE_RPC_URLS,
  LiveCheckError,
  matchScenario,
  OTHER_PK,
  parseMandate,
  parseUsdc,
  parseVerdict,
  payeeText,
  remaining,
  SCENARIO_INPUTS,
  viewCall,
} from "./live-check";

const MANDATE_1 = {
  id: 1,
  payee: { type: "near", account_id: "probarion-payee.testnet" },
  purpose_hash: "ad18",
  max_per_payment: "5000000",
  max_total: "20000000",
  spent: "1000000",
  reserved: "0",
  max_uses: 5,
  uses: 1,
  expires_at_ns: "1796109001000000000",
  approval_above: "5000000",
  agent_pk: "ed25519:5errZXjDMXpk51BLypA3hBRUfBfh9v4bHeyU9vRmzYFK",
  label: "smoke near",
  status: "active",
  created_at_ns: "1793517009951314099",
};

/** A JSON-RPC `call_function` answer whose result bytes are `value` as JSON. */
const rpcOk = (value: unknown, blockHeight = 7) =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        result: [...new TextEncoder().encode(JSON.stringify(value))],
        logs: [],
        block_height: blockHeight,
        block_hash: "x",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("parseUsdc", () => {
  it.each([
    ["2", 2_000_000n],
    ["0", 0n],
    ["0.000001", 1n],
    ["19.5", 19_500_000n],
    ["1000000", 1_000_000_000_000n],
    [" 3 ", 3_000_000n],
  ])("reads %j as %s base units", (input, units) => {
    expect(parseUsdc(input)).toBe(units);
  });

  it.each(["", "abc", "-1", "1e3", "1,5", ".5", "5.", "0.0000001", "1000000.000001", "12345678"])(
    "refuses %j",
    (input) => {
      expect(parseUsdc(input)).toBeNull();
    },
  );
});

describe("formatUsdc", () => {
  it("drops trailing zeros and keeps six decimals at most", () => {
    expect(formatUsdc(5_000_000n)).toBe("5");
    expect(formatUsdc("19500000")).toBe("19.5");
    expect(formatUsdc(1n)).toBe("0.000001");
  });
});

describe("checkSpendArgs", () => {
  it("builds the contract's SpendRequest with no recipient", () => {
    const a = checkSpendArgs(1, 2_000_000n, OTHER_PK);
    expect(a).toEqual({
      request: {
        mandate_id: 1,
        amount: "2000000",
        invoice_hash: "0".repeat(64),
        ref: "landing-demo",
        decision_hash: "0".repeat(64),
      },
      signer_pk: OTHER_PK,
    });
    expect(JSON.stringify(a)).not.toMatch(/recipient|payee|receiver/);
  });
});

describe("parseVerdict", () => {
  it("reads the three answers the contract gives", () => {
    expect(parseVerdict({ ok: true, code: null, would_hold: false })).toEqual({
      ok: true,
      code: null,
      wouldHold: false,
    });
    expect(
      parseVerdict({ ok: false, code: "PROBARION:OverPerPayment", would_hold: false }),
    ).toEqual({ ok: false, code: "OverPerPayment", wouldHold: false });
    expect(parseVerdict({ ok: true, code: null, would_hold: true }).wouldHold).toBe(true);
  });

  it.each([
    null,
    "ok",
    { ok: "true", code: null, would_hold: false },
    { ok: true, code: null },
    { ok: true, code: null, would_hold: false, extra: 1 },
    { ok: true, code: "NoMandate", would_hold: false },
    { ok: false, code: null, would_hold: false },
    { ok: false, code: "", would_hold: false },
    // A hostile or broken answer must not reach the sentence lookup as an object key.
    { ok: false, code: "__proto__", would_hold: false },
    { ok: false, code: "PROBARION:__proto__", would_hold: false },
    { ok: false, code: "Over1", would_hold: false },
    { ok: false, code: "Over Payment", would_hold: false },
    { ok: false, code: "A".repeat(65), would_hold: false },
  ])("refuses %j as an rpc error", (raw) => {
    expect(() => parseVerdict(raw)).toThrow(LiveCheckError);
    try {
      parseVerdict(raw);
    } catch (e) {
      expect((e as LiveCheckError).kind).toBe("rpc");
    }
  });

  it("lets a plain word like `constructor` through as a code: the sentence lookup, not the parser, refuses it", () => {
    // /^[A-Za-z]{1,64}$/ is all letters; live-check-view.test.ts holds that such a word gets the unknown-code sentence.
    expect(parseVerdict({ ok: false, code: "constructor", would_hold: false }).code).toBe(
      "constructor",
    );
  });
});

describe("parseMandate", () => {
  it("reads mandate 1 as the testnet vault returns it", () => {
    const m = parseMandate(MANDATE_1);
    expect(m).toMatchObject({ id: 1, maxPerPayment: "5000000", uses: 1, maxUses: 5 });
    expect(m && payeeText(m.payee)).toBe("probarion-payee.testnet");
    expect(m && remaining(m)).toBe(19_000_000n);
    expect(m && expiryDate(m)).toBe("2026-12-01");
  });

  it("reads null as no mandate", () => {
    expect(parseMandate(null)).toBeNull();
  });

  it("takes expires_at_ns as a u64 decimal string and nothing larger", () => {
    const max = "18446744073709551615";
    expect(parseMandate({ ...MANDATE_1, expires_at_ns: max })?.expiresAtNs).toBe(max);
    for (const bad of ["18446744073709551616", "1".repeat(21), "1".repeat(39), "", "-1", "1e9"]) {
      expect(() => parseMandate({ ...MANDATE_1, expires_at_ns: bad }), bad).toThrow(LiveCheckError);
    }
  });

  it("shows the raw text of an expiry the calendar cannot hold", () => {
    const m = parseMandate(MANDATE_1);
    if (m === null) throw new Error("mandate 1 did not parse");
    expect(expiryDate({ ...m, expiresAtNs: "9999999999999999999999" })).toBe(
      "9999999999999999999999",
    );
  });

  it("shortens an Intents payee and names its chain", () => {
    const m = parseMandate({
      ...MANDATE_1,
      payee: {
        type: "intents",
        chain: "base",
        address: "0x1111111111111111111111111111111111111111",
        asset: "base-usdc.probarion.testnet",
      },
    });
    expect(m && payeeText(m.payee)).toBe("0x1111…1111 on base");
  });

  it.each([
    { ...MANDATE_1, max_total: 20000000 },
    { ...MANDATE_1, payee: { type: "near" } },
    { ...MANDATE_1, uses: "1" },
    { ...MANDATE_1, agent_pk: 5 },
  ])("refuses a malformed mandate", (raw) => {
    expect(() => parseMandate(raw)).toThrow(LiveCheckError);
  });

  it("never reports less than nothing left", () => {
    const m = parseMandate({ ...MANDATE_1, spent: "20000000", reserved: "1" });
    expect(m && remaining(m)).toBe(0n);
  });
});

describe("viewCall", () => {
  const args = { mandate_id: 1 };

  it("returns the decoded value, the block height and the host that answered", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push(url);
      const body = JSON.parse(String(init.body));
      expect(body.params).toMatchObject({
        request_type: "call_function",
        finality: "final",
        account_id: "v0.probarion.testnet",
        method_name: "get_mandate",
      });
      expect(JSON.parse(atob(body.params.args_base64))).toEqual(args);
      return rpcOk({ ok: true }, 42);
    }) as unknown as typeof globalThis.fetch;
    const a = await viewCall(LIVE_RPC_URLS, "v0.probarion.testnet", "get_mandate", args, {
      fetch,
    });
    expect(a).toEqual({
      value: { ok: true },
      blockHeight: 42,
      rpcHost: "rpc.testnet.fastnear.com",
    });
    expect(seen).toEqual([LIVE_RPC_URLS[0]]);
  });

  it.each([
    ["an HTTP 429", () => new Response("slow down", { status: 429 })],
    ["an HTTP 500", () => new Response("", { status: 500 })],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
    [
      "a JSON-RPC error that is not about the target",
      () =>
        new Response(
          JSON.stringify({
            error: { name: "HANDLER_ERROR", cause: { name: "TOO_MANY_REQUESTS" } },
          }),
        ),
    ],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
  ])("moves on to the second host after %s", async (_, first) => {
    let n = 0;
    const fetch = (async () =>
      n++ === 0 ? first() : rpcOk(null)) as unknown as typeof globalThis.fetch;
    const a = await viewCall(LIVE_RPC_URLS, "v0.probarion.testnet", "get_mandate", args, { fetch });
    expect(a.rpcHost).toBe("rpc.testnet.near.org");
  });

  it("does not move on after a contract answer, and calls it contract", async () => {
    let n = 0;
    const fetch = (async () => {
      n++;
      return new Response(
        JSON.stringify({ result: { error: "wasm execution failed", logs: [], block_height: 1 } }),
      );
    }) as unknown as typeof globalThis.fetch;
    await expect(
      viewCall(LIVE_RPC_URLS, "v0.probarion.testnet", "check_spend", args, { fetch }),
    ).rejects.toMatchObject({ kind: "contract" });
    expect(n).toBe(1);
  });

  it("calls an unknown account a contract answer", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }),
      )) as unknown as typeof globalThis.fetch;
    await expect(
      viewCall(LIVE_RPC_URLS, "nobody.testnet", "get_mandate", args, { fetch }),
    ).rejects.toMatchObject({ kind: "contract" });
  });

  it("says transport when every host fails", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    await expect(
      viewCall(LIVE_RPC_URLS, "v0.probarion.testnet", "get_mandate", args, { fetch }),
    ).rejects.toMatchObject({ kind: "transport" });
  });

  it("gives up on a host after the timeout and tries the next", async () => {
    let n = 0;
    const fetch = ((_: string, init: RequestInit) =>
      n++ === 0
        ? new Promise((_r, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("t", "AbortError")),
            ),
          )
        : Promise.resolve(rpcOk(1))) as unknown as typeof globalThis.fetch;
    const a = await viewCall(LIVE_RPC_URLS, "v0.probarion.testnet", "get_mandate", args, {
      fetch,
      timeoutMs: 20,
    });
    expect(a.value).toBe(1);
  });

  it.each([[[1, 300]], [[1.5]], [["a"]], [[-1]], ["not an array"]])(
    "refuses a result that is not a byte array (%j) on every host",
    async (bytes) => {
      let n = 0;
      const fetch = (async () => {
        n++;
        return new Response(
          JSON.stringify({ result: { result: bytes, logs: [], block_height: 3 } }),
        );
      }) as unknown as typeof globalThis.fetch;
      await expect(
        viewCall(LIVE_RPC_URLS, "v0.probarion.testnet", "get_mandate", args, { fetch }),
      ).rejects.toMatchObject({ kind: "rpc" });
      expect(n).toBe(LIVE_RPC_URLS.length);
    },
  );

  it("makes no request at all when the caller has already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    let n = 0;
    const fetch = (async () => {
      n++;
      return rpcOk(1);
    }) as unknown as typeof globalThis.fetch;
    await expect(
      viewCall(LIVE_RPC_URLS, "v0.probarion.testnet", "get_mandate", args, {
        fetch,
        signal: ctl.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(n).toBe(0);
  });

  it("stops at once, and tries no other host, when the caller aborts", async () => {
    const ctl = new AbortController();
    let n = 0;
    const fetch = ((_: string, init: RequestInit) => {
      n++;
      return new Promise((_r, reject) =>
        init.signal?.addEventListener("abort", () => reject(new DOMException("a", "AbortError"))),
      );
    }) as unknown as typeof globalThis.fetch;
    const p = viewCall(LIVE_RPC_URLS, "v0.probarion.testnet", "get_mandate", args, {
      fetch,
      signal: ctl.signal,
    });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(n).toBe(1);
  });
});

describe("the scenarios", () => {
  it("are the five the spec names, with amounts parseUsdc accepts", () => {
    expect(SCENARIO_INPUTS.map((s) => s.id)).toEqual([
      "normal",
      "hijack",
      "inflated",
      "nomandate",
      "otherkey",
    ]);
    for (const s of SCENARIO_INPUTS) expect(parseUsdc(s.amount), s.id).not.toBeNull();
  });

  it("send the hijack as the normal invoice: the agent passes on the amount, and no field holds the address", () => {
    const of = (id: string) => SCENARIO_INPUTS.find((s) => s.id === id);
    const { id: _n, ...normal } = of("normal") ?? { id: "" };
    const { id: _h, ...hijack } = of("hijack") ?? { id: "" };
    expect(hijack).toEqual(normal);
    expect(of("hijack")?.amount).toBe("2");
    expect(of("inflated")).toMatchObject({ mandateId: 1, amount: "50", key: "agent" });
  });

  it("are recognised from the controls, and only exactly", () => {
    expect(matchScenario({ mandateId: 1, amount: "50", key: "agent" })).toBe("inflated");
    expect(matchScenario({ mandateId: 1, amount: "50.0", key: "agent" })).toBe("inflated");
    // Typed by hand, the hijack's fields are the normal invoice's: only its button picks the hijack.
    expect(matchScenario({ mandateId: 1, amount: "2", key: "agent" })).toBe("normal");
    expect(matchScenario({ mandateId: 1, amount: "49", key: "agent" })).toBeNull();
    expect(matchScenario({ mandateId: 1, amount: "abc", key: "agent" })).toBeNull();
  });

  it("use only testnet RPC hosts, and a fixed other key", () => {
    for (const url of LIVE_RPC_URLS) expect(new URL(url).host.split(/[.\-_]/)).toContain("testnet");
    expect(OTHER_PK).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });
});

describe("fill", () => {
  it("replaces each {name}, and leaves an unknown one as it is", () => {
    expect(fill("{amount} USDC to {payee}, {x}", { amount: 2, payee: "a.testnet" })).toBe(
      "2 USDC to a.testnet, {x}",
    );
  });

  it("ignores names a plain object inherits", () => {
    expect(fill("{constructor} {toString} {__proto__} {hasOwnProperty}", {})).toBe(
      "{constructor} {toString} {__proto__} {hasOwnProperty}",
    );
  });
});
