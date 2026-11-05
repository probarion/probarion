import { quoteHash, verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { describe, expect, it, vi } from "vitest";
import {
  BOUND_FIELDS,
  buildQuoteRequest,
  checkQuote,
  fetchQuote,
  getDepositStatus,
  ONECLICK_BASE,
  QuoteError,
  type QuoteRequestBody,
  submitDeposit,
} from "./oneclick";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const BASE = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const VAULT = "acme.vaults.probarion.near";
const now = new Date("2026-11-08T10:00:00Z");
const kp = nacl.sign.keyPair();
const TEST_KEY = `ed25519:${bs58.encode(kp.publicKey)}`;
const verifyWithTestKey = (r: unknown) =>
  verifyQuoteSignature(r as Parameters<typeof verifyQuoteSignature>[0], TEST_KEY);

/** A live (non-dry) 1Click response, signed exactly as the SDK hashes it. */
function signedResponse(
  request: QuoteRequestBody,
  quoteOverrides: Record<string, unknown> = {},
  timestamp = now.toISOString(),
) {
  const quote = {
    depositAddress: "ab".repeat(32),
    amountIn: "20208197",
    amountInFormatted: "20.208197",
    amountInUsd: "20.2082",
    minAmountIn: "20006115",
    amountOut: request.amount,
    amountOutFormatted: "20",
    amountOutUsd: "20",
    minAmountOut: request.amount,
    deadline: new Date(now.getTime() + 30 * 60_000).toISOString(),
    timeWhenInactive: new Date(now.getTime() + 60 * 60_000).toISOString(),
    timeEstimate: 12,
    ...quoteOverrides,
  };
  const resp = { correlationId: "c-1", timestamp, signature: "", quoteRequest: request, quote };
  const message = new TextEncoder().encode(quoteHash(resp as Parameters<typeof quoteHash>[0]));
  resp.signature = `ed25519:${bs58.encode(nacl.sign.detached(message, kp.secretKey))}`;
  return resp;
}

const req = () =>
  buildQuoteRequest(
    { vault: VAULT, owner: "acme.near", amountOut: "20000000", usdc: USDC, baseAsset: BASE },
    now,
  );

describe("1Click top-up quotes", () => {
  it("asks for Base USDC delivered INTO the vault's intents.near account", () => {
    expect(req()).toEqual({
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: `nep141:${USDC}`,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: `nep141:${BASE}`,
      amount: "20000000",
      refundTo: "acme.near",
      refundType: "ORIGIN_CHAIN",
      recipient: VAULT,
      recipientType: "INTENTS",
      deadline: "2026-11-08T10:30:00.000Z",
      quoteWaitingTimeMs: 3000,
      referral: "probarion",
    });
  });

  it("accepts a correctly signed live quote that matches the request", () => {
    const r = checkQuote(signedResponse(req()), req(), now, verifyWithTestKey);
    expect(r).toMatchObject({
      ok: true,
      quote: { depositAddress: "ab".repeat(32), amountIn: "20208197", amountOut: "20000000" },
    });
  });

  // probarion-claim: ONECLICK-QUOTE
  it("rejects a quote tampered with after signing", () => {
    const resp = signedResponse(req());
    resp.quoteRequest = { ...resp.quoteRequest, recipient: "evil.near" };
    expect(checkQuote(resp, req(), now, verifyWithTestKey)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a genuinely signed quote for a different recipient (binding check)", () => {
    const resp = signedResponse({ ...req(), recipient: "evil.near" });
    expect(checkQuote(resp, req(), now, verifyWithTestKey)).toEqual({
      ok: false,
      reason: "mismatch:recipient",
    });
  });

  it("rejects stale, overpriced, dry and badly addressed quotes", () => {
    expect(
      checkQuote(signedResponse(req(), {}, "2026-11-08T09:50:00Z"), req(), now, verifyWithTestKey),
    ).toEqual({ ok: false, reason: "stale_quote" });
    expect(
      checkQuote(signedResponse(req(), { amountIn: "25000000" }), req(), now, verifyWithTestKey),
    ).toEqual({ ok: false, reason: "price_too_high" });
    expect(
      checkQuote(signedResponse({ ...req(), dry: true }), req(), now, verifyWithTestKey),
    ).toEqual({ ok: false, reason: "mismatch:dry" });
    expect(
      checkQuote(
        signedResponse(req(), { depositAddress: "Not An Account" }),
        req(),
        now,
        verifyWithTestKey,
      ),
    ).toEqual({ ok: false, reason: "bad_deposit_address" });
  });

  it("uses the official 1Click key by default (our test key is not trusted)", () => {
    expect(checkQuote(signedResponse(req()), req(), now)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("posts the quote with the partner JWT", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }) as typeof fetch;
    await fetchQuote(req(), "jwt-123", f);
    expect(seen[0]?.url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(header({ init: seen[0]?.init ?? {} }, "authorization")).toBe("Bearer jwt-123");
  });
});

/** A different value for each bound field: signed by the (test) 1Click key, so only the binding can catch it. */
const OTHER: Record<(typeof BOUND_FIELDS)[number], unknown> = {
  dry: true,
  swapType: "EXACT_INPUT",
  originAsset: "nep141:evil.near",
  depositType: "INTENTS",
  destinationAsset: "nep141:evil.omft.near",
  amount: "20000001",
  refundTo: "evil.near",
  refundType: "INTENTS",
  recipient: "evil.near",
  recipientType: "DESTINATION_CHAIN",
};

/** One header of a recorded call. */
const header = (call: { init: RequestInit } | undefined, name: string): string | undefined =>
  (call?.init.headers as Record<string, string> | undefined)?.[name];

const check = (resp: unknown, verify: (r: unknown) => boolean = verifyWithTestKey) =>
  checkQuote(resp, req(), now, verify);
const reject = (reason: string) => ({ ok: false, reason });

describe("checkQuote refuses a quote for every field the request bound", () => {
  it("covers each bound field, and no other", () => {
    expect(Object.keys(OTHER).sort()).toEqual([...BOUND_FIELDS].sort());
  });

  it.each(BOUND_FIELDS)("mismatch:%s", (field) => {
    const resp = signedResponse({ ...req(), [field]: OTHER[field] } as QuoteRequestBody);
    expect(check(resp)).toEqual(reject(`mismatch:${field}`));
  });

  it("names the first mismatching field, after the signature has been checked", () => {
    const resp = signedResponse({
      ...req(),
      recipient: "evil.near",
      refundTo: "evil.near",
    } as QuoteRequestBody);
    expect(check(resp)).toEqual(reject("mismatch:refundTo"));
    resp.signature = signedResponse(req()).signature; // a signature for another quote
    expect(check(resp)).toEqual(reject("bad_signature"));
  });

  it("returns the recipient and the refund address it checked, not ones it was handed elsewhere", () => {
    const r = check(signedResponse(req()));
    expect(r).toMatchObject({ ok: true, quote: { recipient: VAULT, refundTo: "acme.near" } });
  });
});

describe("checkQuote fails closed on a response that is not shaped like a quote", () => {
  const good = () => signedResponse(req()) as Record<string, unknown>;

  const cases: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "quote"],
    ["a number", 42],
    ["an array", []],
    ["an empty object", {}],
    ["no quote", { ...good(), quote: undefined }],
    ["a null quote", { ...good(), quote: null }],
    ["an array as the quote", { ...good(), quote: [] }],
    ["no quoteRequest", { ...good(), quoteRequest: undefined }],
    ["a string as the quoteRequest", { ...good(), quoteRequest: "request" }],
    ["no signature", { ...good(), signature: undefined }],
    ["a numeric signature", { ...good(), signature: 5 }],
    ["no timestamp", { ...good(), timestamp: undefined }],
    ["a numeric timestamp", { ...good(), timestamp: 1_794_000_000 }],
  ];

  it.each(cases)("%s is malformed, and no signature check runs", (_name, resp) => {
    const verify = vi.fn(() => true);
    expect(check(resp, verify)).toEqual(reject("malformed"));
    expect(verify).not.toHaveBeenCalled();
  });

  it("treats a verifier that throws as a bad signature", () => {
    const boom = () => {
      throw new Error("bad key");
    };
    expect(check(signedResponse(req()), boom)).toEqual(reject("bad_signature"));
  });

  it("treats a verifier that says anything but true as a bad signature", () => {
    expect(check(signedResponse(req()), () => 1 as unknown as boolean)).toEqual(
      reject("bad_signature"),
    );
    expect(check(signedResponse(req()), () => false)).toEqual(reject("bad_signature"));
  });

  it("refuses a deposit address that is not a NEAR account", () => {
    for (const depositAddress of ["", "UPPER.near", "a b", 5, null, ["ab".repeat(32)]]) {
      expect(check(signedResponse(req(), { depositAddress }))).toEqual(
        reject("bad_deposit_address"),
      );
    }
    expect(check(signedResponse(req(), { depositAddress: undefined }))).toEqual(
      reject("bad_deposit_address"),
    );
  });
});

describe("checkQuote and amounts", () => {
  const NOT_AMOUNTS: unknown[] = [
    "abc",
    "",
    " 5",
    "5 ",
    "20.5",
    "-1",
    "+5",
    "1e7",
    "0x10",
    "020208197",
    "0",
    "9".repeat(60),
    "340282366920938463463374607431768211456", // 2^128, one past a U128
    20208197,
    null,
    true,
    {},
  ];

  it.each(NOT_AMOUNTS.map((v) => [JSON.stringify(v) ?? "undefined", v]))(
    "amountIn %s is malformed, and nothing throws",
    (_name, amountIn) => {
      expect(check(signedResponse(req(), { amountIn }))).toEqual(reject("malformed"));
    },
  );

  it("treats a missing amountIn as malformed", () => {
    expect(check(signedResponse(req(), { amountIn: undefined }))).toEqual(reject("malformed"));
  });

  it.each(NOT_AMOUNTS.filter((v) => v !== "0").map((v) => [JSON.stringify(v), v]))(
    "amountOut %s is malformed, and nothing throws",
    (_name, amountOut) => {
      expect(check(signedResponse(req(), { amountOut }))).toEqual(reject("malformed"));
    },
  );

  it("treats a missing amountOut as malformed", () => {
    expect(check(signedResponse(req(), { amountOut: undefined }))).toEqual(reject("malformed"));
  });

  it("refuses an output below what was asked for, by one unit", () => {
    expect(check(signedResponse(req(), { amountOut: "19999999" }))).toEqual(
      reject("amount_out_too_low"),
    );
    expect(check(signedResponse(req(), { amountOut: "0" }))).toEqual(reject("amount_out_too_low"));
  });

  it("accepts an output at or above what was asked for", () => {
    expect(check(signedResponse(req(), { amountOut: "20000000" })).ok).toBe(true);
    expect(check(signedResponse(req(), { amountOut: "20000001" }))).toMatchObject({
      ok: true,
      quote: { amountOut: "20000001" },
    });
  });

  it("allows an input up to 5% over the output, and not one unit more", () => {
    expect(check(signedResponse(req(), { amountIn: "21000000" })).ok).toBe(true);
    expect(check(signedResponse(req(), { amountIn: "21000001" }))).toEqual(
      reject("price_too_high"),
    );
  });

  it("shows amounts it formatted itself from the units, not the text 1Click sent", () => {
    const r = check(
      signedResponse(req(), { amountInFormatted: "0.01", amountOutFormatted: "99999" }),
    );
    expect(r).toMatchObject({
      ok: true,
      quote: { amountInFormatted: "20.208197", amountOutFormatted: "20" },
    });
  });
});

describe("checkQuote and time", () => {
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();

  it("accepts a timestamp up to 5 minutes either side of now, and no further", () => {
    expect(check(signedResponse(req(), {}, at(-5 * 60_000))).ok).toBe(true);
    expect(check(signedResponse(req(), {}, at(5 * 60_000))).ok).toBe(true);
    expect(check(signedResponse(req(), {}, at(-5 * 60_000 - 1)))).toEqual(reject("stale_quote"));
  });

  it("refuses a timestamp more than 5 minutes in the future", () => {
    expect(check(signedResponse(req(), {}, at(5 * 60_000 + 1)))).toEqual(reject("stale_quote"));
    expect(check(signedResponse(req(), {}, at(60 * 60_000)))).toEqual(reject("stale_quote"));
  });

  it("refuses a timestamp that is not a date", () => {
    expect(check(signedResponse(req(), {}, "yesterday"))).toEqual(reject("stale_quote"));
    expect(check(signedResponse(req(), {}, ""))).toEqual(reject("stale_quote"));
  });

  it("wants the deposit address open for at least 5 more minutes", () => {
    expect(check(signedResponse(req(), { deadline: at(5 * 60_000) })).ok).toBe(true);
    expect(check(signedResponse(req(), { deadline: at(5 * 60_000 - 1) }))).toEqual(
      reject("deadline_too_close"),
    );
    expect(check(signedResponse(req(), { deadline: at(-60_000) }))).toEqual(
      reject("deadline_too_close"),
    );
  });

  it("fails closed when the deadline is missing or is not a date", () => {
    for (const deadline of [undefined, null, "", "soon", 1_794_000_000]) {
      expect(check(signedResponse(req(), { deadline }))).toEqual(reject("malformed"));
    }
  });

  it("returns the deadline it checked", () => {
    expect(check(signedResponse(req()))).toMatchObject({
      ok: true,
      quote: { deadline: "2026-11-08T10:30:00.000Z" },
    });
  });
});

describe("checkQuote and the deposit memo", () => {
  it("keeps a memo for the transfer, and reads none as null", () => {
    expect(check(signedResponse(req(), { depositMemo: "m-1" }))).toMatchObject({
      ok: true,
      quote: { depositMemo: "m-1" },
    });
    expect(check(signedResponse(req()))).toMatchObject({ ok: true, quote: { depositMemo: null } });
    expect(check(signedResponse(req(), { depositMemo: "" }))).toMatchObject({
      ok: true,
      quote: { depositMemo: null },
    });
  });

  it("refuses a memo that is not text, rather than dropping it", () => {
    for (const depositMemo of [123, true, {}, ["m"]]) {
      expect(check(signedResponse(req(), { depositMemo }))).toEqual(reject("malformed"));
    }
  });
});

describe("1Click HTTP calls", () => {
  const sent = () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const reply = (body: unknown, status = 200) =>
      (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    return { calls, reply };
  };

  it("sends the quote request as JSON, with a timeout", async () => {
    const { calls, reply } = sent();
    const answer = await fetchQuote(req(), "jwt-1", reply({ quote: 1 }, 201));
    expect(answer).toEqual({ quote: 1 });
    expect(calls[0]?.url).toBe(`${ONECLICK_BASE}/v0/quote`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(req());
    expect(header(calls[0], "content-type")).toBe("application/json");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("turns a refusal into a QuoteError that says the status and 1Click's reason", async () => {
    const { reply } = sent();
    const err = await fetchQuote(req(), "j", reply({ message: "amount too small" }, 400)).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(QuoteError);
    expect((err as QuoteError).message).toBe("1Click quote failed (400): amount too small");
  });

  it("keeps a long or missing reason short and safe", async () => {
    const { reply } = sent();
    const long = await fetchQuote(req(), "j", reply({ message: "x".repeat(900) }, 500)).catch(
      (e) => e,
    );
    expect((long as QuoteError).message.length).toBeLessThan(260);
    const none = await fetchQuote(req(), "j", reply({}, 503)).catch((e) => e);
    expect((none as QuoteError).message).toBe("1Click quote failed (503): no detail");
    const notJson = (async () =>
      new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
    const html = await fetchQuote(req(), "j", notJson).catch((e) => e);
    expect((html as QuoteError).message).toBe("1Click quote failed (502): no detail");
  });

  it("drops control and direction characters from 1Click's reason", async () => {
    const { reply } = sent();
    const err = await fetchQuote(
      req(),
      "j",
      reply({ message: "too\u0007 small‮\n\u0085and low" }, 400),
    ).catch((e) => e);
    expect((err as QuoteError).message).toBe("1Click quote failed (400): too smalland low");
  });

  it("turns a network failure into a QuoteError that leaks nothing", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed: Bearer jwt-secret to https://1click.chaindefuser.com");
    }) as typeof fetch;
    const err = await fetchQuote(req(), "jwt-secret", down).catch((e) => e);
    expect(err).toBeInstanceOf(QuoteError);
    expect((err as QuoteError).message).toBe("1Click could not be reached");
  });

  it("answers an unreadable success body as null, which checkQuote then refuses", async () => {
    const notJson = (async () => new Response("ok", { status: 201 })) as typeof fetch;
    const answer = await fetchQuote(req(), "j", notJson);
    expect(answer).toBeNull();
    expect(check(answer)).toEqual(reject("malformed"));
  });

  it("submits a deposit with the partner JWT", async () => {
    const { calls, reply } = sent();
    const input = {
      txHash: "h".repeat(44),
      depositAddress: "ab".repeat(32),
      nearSenderAccount: "acme.near",
    };
    await submitDeposit("jwt-2", input, reply({ status: "KNOWN_DEPOSIT_TX" }));
    expect(calls[0]?.url).toBe(`${ONECLICK_BASE}/v0/deposit/submit`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(input);
    expect(header(calls[0], "authorization")).toBe("Bearer jwt-2");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("raises a QuoteError when a deposit submit is refused or cannot be sent", async () => {
    const { reply } = sent();
    const input = { txHash: "h", depositAddress: "ab".repeat(32), nearSenderAccount: "acme.near" };
    await expect(submitDeposit("j", input, reply({}, 400))).rejects.toThrow(
      "1Click deposit/submit failed (400)",
    );
    const down = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    await expect(submitDeposit("j", input, down)).rejects.toThrow("1Click could not be reached");
  });

  it("reads a deposit's status, URL-encoding the address, and returns only the status and its time", async () => {
    const { calls, reply } = sent();
    const out = await getDepositStatus(
      "jwt-3",
      "ab cd",
      reply({
        status: "PROCESSING",
        updatedAt: "2026-11-08T10:01:00Z",
        quoteResponse: { secret: "do not pass on" },
        swapDetails: {},
      }),
    );
    expect(out).toEqual({ status: "PROCESSING", updatedAt: "2026-11-08T10:01:00Z" });
    expect(calls[0]?.url).toBe(`${ONECLICK_BASE}/v0/status?depositAddress=ab%20cd`);
    expect(header(calls[0], "authorization")).toBe("Bearer jwt-3");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a status that is not one word in capitals, and a refused read", async () => {
    const { reply } = sent();
    for (const body of [{}, { status: 5 }, { status: "<b>x</b>" }, { status: "" }, null, "x"]) {
      await expect(getDepositStatus("j", "a1", reply(body))).rejects.toBeInstanceOf(QuoteError);
    }
    await expect(getDepositStatus("j", "a1", reply({}, 404))).rejects.toThrow(
      "1Click status failed (404)",
    );
    const down = (async () => {
      throw new Error("dns");
    }) as typeof fetch;
    await expect(getDepositStatus("j", "a1", down)).rejects.toThrow("1Click could not be reached");
  });

  it("drops an updatedAt that is not text", async () => {
    const { reply } = sent();
    expect(await getDepositStatus("j", "a1", reply({ status: "SUCCESS", updatedAt: 5 }))).toEqual({
      status: "SUCCESS",
    });
  });
});
