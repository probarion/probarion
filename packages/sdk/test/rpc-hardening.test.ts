import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, RpcError, ViewError } from "../src/errors.js";
import { RpcClient, toAccessKeyInfo, toTxStatusResult } from "../src/rpc.js";
import { bytesOf, client, json, ok } from "./helpers/rpc-fakes.js";

// ---------- fixtures for the response validators ----------

const outcomeBody = (over: Record<string, unknown> = {}) => ({
  logs: [],
  receipt_ids: [],
  executor_id: "token.testnet",
  status: {},
  ...over,
});
const receipt = (over: Record<string, unknown> = {}) => ({
  id: "R1",
  outcome: outcomeBody(),
  ...over,
});
// A key set to `undefined` is dropped by JSON.stringify, so it models a missing field.
const txBody = (over: Record<string, unknown> = {}) => ({
  status: { SuccessValue: "" },
  transaction: { hash: "Tx1", signer_id: "vault.testnet", receiver_id: "vault.testnet" },
  transaction_outcome: receipt({
    id: "Tx1",
    outcome: outcomeBody({ executor_id: "vault.testnet" }),
  }),
  receipts_outcome: [receipt()],
  ...over,
});
const accountBody = (over: Record<string, unknown> = {}) => ({
  amount: "1",
  locked: "0",
  code_hash: "Hash111",
  storage_usage: 100,
  ...over,
});

describe("txStatus rejects a garbled 200 (response validation)", () => {
  it("accepts a well-formed result", async () => {
    const { rpc } = client(["https://a.test"], [ok(txBody())]);
    const tx = await rpc.txStatus("Tx1", "vault.testnet");
    expect(tx.transaction.hash).toBe("Tx1");
    expect(tx.transaction_outcome.outcome.executor_id).toBe("vault.testnet");
    expect(tx.receipts_outcome).toHaveLength(1);
  });

  const broken: [string, unknown][] = [
    ["a string body", "garbage"],
    ["an array body", []],
    ["status missing", txBody({ status: undefined })],
    ["status null", txBody({ status: null })],
    ["transaction missing", txBody({ transaction: undefined })],
    ["transaction not an object", txBody({ transaction: "Tx1" })],
    ["transaction.hash missing", txBody({ transaction: { signer_id: "a", receiver_id: "b" } })],
    ["transaction.hash not a string", txBody({ transaction: { hash: 7 } })],
    ["transaction_outcome missing", txBody({ transaction_outcome: undefined })],
    ["transaction_outcome.id missing", txBody({ transaction_outcome: receipt({ id: undefined }) })],
    [
      "transaction_outcome.outcome missing",
      txBody({ transaction_outcome: receipt({ id: "Tx1", outcome: undefined }) }),
    ],
    [
      "transaction_outcome.outcome not an object",
      txBody({ transaction_outcome: receipt({ id: "Tx1", outcome: "ok" }) }),
    ],
    [
      "transaction_outcome.outcome.executor_id missing",
      txBody({
        transaction_outcome: receipt({
          id: "Tx1",
          outcome: outcomeBody({ executor_id: undefined }),
        }),
      }),
    ],
    ["receipts_outcome missing", txBody({ receipts_outcome: undefined })],
    ["receipts_outcome not an array", txBody({ receipts_outcome: { R1: receipt() } })],
    ["a receipt that is not an object", txBody({ receipts_outcome: ["R1"] })],
    ["a receipt without id", txBody({ receipts_outcome: [receipt({ id: undefined })] })],
    ["a receipt with a numeric id", txBody({ receipts_outcome: [receipt({ id: 1 })] })],
    ["a receipt without outcome", txBody({ receipts_outcome: [receipt({ outcome: undefined })] })],
    [
      "a receipt with a non-object outcome",
      txBody({ receipts_outcome: [receipt({ outcome: [] })] }),
    ],
    [
      "a receipt without executor_id",
      txBody({ receipts_outcome: [receipt({ outcome: outcomeBody({ executor_id: undefined }) })] }),
    ],
    [
      "a receipt with a non-string executor_id",
      txBody({ receipts_outcome: [receipt({ outcome: outcomeBody({ executor_id: 5 }) })] }),
    ],
    [
      "a bad receipt after a good one",
      txBody({ receipts_outcome: [receipt(), receipt({ id: "R2", outcome: null })] }),
    ],
  ];

  it.each(broken)("throws RpcError('malformed tx result') for %s", async (_name, body) => {
    const { rpc, calls } = client(["https://a.test"], [ok(body)]);
    const error = await rpc.txStatus("Tx1", "vault.testnet").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).message).toMatch(/malformed tx result/);
    expect(calls).toHaveLength(1);
  });

  it("toTxStatusResult throws on null and primitives", () => {
    expect(() => toTxStatusResult(null)).toThrow(/malformed tx result/);
    expect(() => toTxStatusResult(42)).toThrow(/malformed tx result/);
  });
});

describe("viewAccount rejects a garbled 200 (response validation)", () => {
  it("accepts a well-formed result", async () => {
    const { rpc } = client(["https://a.test"], [ok(accountBody())]);
    expect(await rpc.viewAccount("a.testnet")).toEqual({
      amount: "1",
      locked: "0",
      code_hash: "Hash111",
      global_contract_hash: null,
      storage_usage: 100,
    });
  });

  const broken: [string, Record<string, unknown>, RegExp][] = [
    ["code_hash missing", { code_hash: undefined }, /malformed result/],
    ["code_hash not a string", { code_hash: 5 }, /malformed result/],
    ["amount missing", { amount: undefined }, /malformed amount/],
    ["amount a number", { amount: 1 }, /malformed amount/],
    ["amount not a decimal string", { amount: "1e24" }, /malformed amount/],
    ["amount negative", { amount: "-1" }, /malformed amount/],
    ["locked missing", { locked: undefined }, /malformed locked/],
    ["locked a number", { locked: 0 }, /malformed locked/],
    ["storage_usage missing", { storage_usage: undefined }, /malformed storage_usage/],
    ["storage_usage a string", { storage_usage: "100" }, /malformed storage_usage/],
    ["storage_usage null", { storage_usage: null }, /malformed storage_usage/],
    ["storage_usage negative", { storage_usage: -1 }, /malformed storage_usage/],
    ["storage_usage fractional", { storage_usage: 1.5 }, /malformed storage_usage/],
    ["global_contract_hash empty", { global_contract_hash: "" }, /malformed global_contract_hash/],
    [
      "global_contract_hash a number",
      { global_contract_hash: 42 },
      /malformed global_contract_hash/,
    ],
    [
      "global_contract_hash an object",
      { global_contract_hash: {} },
      /malformed global_contract_hash/,
    ],
  ];

  it.each(broken)("throws RpcError for %s", async (_name, over, message) => {
    const { rpc } = client(["https://a.test"], [ok(accountBody(over))]);
    const error = await rpc.viewAccount("a.testnet").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).message).toMatch(message);
  });

  it("rejects a non-object result", async () => {
    const { rpc } = client(["https://a.test"], [ok("nope")]);
    await expect(rpc.viewAccount("a.testnet")).rejects.toThrow(/malformed result/);
  });
});

// ---------- mapper hardening (M6) ----------

describe("mapper hardening (M6)", () => {
  const key = (functionCall: Record<string, unknown>) => ({
    public_key: "ed25519:K",
    access_key: { nonce: 1, permission: { FunctionCall: functionCall } },
  });

  it("never turns a missing or garbled method_names into [] (which NEAR reads as all methods)", () => {
    const base = { receiver_id: "vault.testnet", allowance: null };
    expect(() => toAccessKeyInfo(key({ ...base }))).toThrow(/method_names/);
    expect(() => toAccessKeyInfo(key({ ...base, method_names: "spend" }))).toThrow(/method_names/);
    expect(() => toAccessKeyInfo(key({ ...base, method_names: null }))).toThrow(/method_names/);
    expect(() => toAccessKeyInfo(key({ ...base, method_names: { 0: "spend" } }))).toThrow(
      /method_names/,
    );
    expect(toAccessKeyInfo(key({ ...base, method_names: [] }))).toEqual({
      public_key: "ed25519:K",
      permission: { receiver_id: "vault.testnet", method_names: [], allowance: null },
    });
  });

  it("requires a string receiver_id", () => {
    expect(() => toAccessKeyInfo(key({ method_names: ["spend"], allowance: null }))).toThrow(
      /receiver_id/,
    );
    expect(() =>
      toAccessKeyInfo(key({ receiver_id: 7, method_names: ["spend"], allowance: null })),
    ).toThrow(/receiver_id/);
  });

  it("surfaces a malformed key through viewAccessKeyList", async () => {
    const { rpc } = client(
      ["https://a.test"],
      [ok({ keys: [key({ receiver_id: "vault.testnet", allowance: null })] })],
    );
    await expect(rpc.viewAccessKeyList("vault.testnet")).rejects.toThrow(RpcError);
  });

  it.each([
    ["a value above 255", [1, 256]],
    ["a negative value", [-1]],
    ["a fractional value", [1.5]],
    ["a numeric string", ["1"]],
    ["a null entry", [null]],
  ])("rejects result bytes with %s", async (_name, bytes) => {
    const { rpc } = client(["https://a.test"], [ok({ result: bytes, logs: [] })]);
    const error = await rpc.viewFunction("vault.testnet", "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViewError);
    expect((error as ViewError).message).toMatch(/not a byte array/);
  });

  it("rejects result bytes that are not valid UTF-8", async () => {
    const { rpc } = client(["https://a.test"], [ok({ result: [255, 254, 34], logs: [] })]);
    await expect(rpc.viewFunction("vault.testnet", "x")).rejects.toThrow(/not valid UTF-8/);
  });

  it("still decodes an empty result as null and ordinary JSON", async () => {
    const empty = client(["https://a.test"], [ok({ result: [], logs: [] })]);
    expect(await empty.rpc.viewFunction("vault.testnet", "x")).toBeNull();
    const text = client(["https://a.test"], [ok({ result: bytesOf({ n: "é" }), logs: [] })]);
    expect(await text.rpc.viewFunction("vault.testnet", "x")).toEqual({ n: "é" });
  });
});

// ---------- error causes ----------

function networkFailure(code: string | null, message = "connect failed"): () => never {
  return () => {
    const cause = Object.assign(new Error(message), code === null ? {} : { code });
    throw new TypeError("fetch failed", { cause });
  };
}

describe("network error causes", () => {
  it.each(["ECONNREFUSED", "ENOTFOUND", "CERT_HAS_EXPIRED"])(
    "tells a %s apart in the attempt text",
    async (code) => {
      const { rpc } = client(["https://a.test"], [networkFailure(code)], [], { maxRounds: 1 });
      const error = (await rpc.viewAccount("a.testnet").catch((e: unknown) => e)) as RpcError;
      expect(error).toBeInstanceOf(RpcError);
      expect(error.attempts).toEqual([
        { url: "https://a.test", error: `network error: fetch failed (${code})` },
      ]);
      expect(error.message).toContain(`(${code})`);
    },
  );

  it("falls back to the cause message, then to the error message", async () => {
    const withMessage = client(
      ["https://a.test"],
      [networkFailure(null, "getaddrinfo failed")],
      [],
      {
        maxRounds: 1,
      },
    );
    const first = (await withMessage.rpc.viewAccount("a").catch((e: unknown) => e)) as RpcError;
    expect(first.attempts[0]?.error).toBe("network error: fetch failed (getaddrinfo failed)");
    const bare = client(
      ["https://a.test"],
      [
        () => {
          throw new TypeError("fetch failed");
        },
      ],
      [],
      { maxRounds: 1 },
    );
    const second = (await bare.rpc.viewAccount("a").catch((e: unknown) => e)) as RpcError;
    expect(second.attempts[0]?.error).toBe("network error: fetch failed");
  });

  it("reports a real refused loopback connection as ECONNREFUSED", async () => {
    const probe = createNetServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    if (address === null || typeof address === "string") throw new Error("no ephemeral port");
    const rpc = new RpcClient({
      urls: [`http://127.0.0.1:${address.port}`],
      maxRounds: 1,
      sleep: async () => {},
    });
    const error = (await rpc.viewAccount("a.testnet").catch((e: unknown) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error.attempts[0]?.error).toMatch(/\(ECONNREFUSED\)/);
  });

  it("builds the give-up error with the last error as cause and names the URLs tried", async () => {
    const original = new TypeError("fetch failed", {
      cause: Object.assign(new Error("x"), { code: "ECONNRESET" }),
    });
    const { rpc } = client(
      ["https://a.test", "https://b.test"],
      [
        () => json({}, 500),
        () => {
          throw original;
        },
      ],
    );
    const error = (await rpc.viewAccount("a.testnet").catch((e: unknown) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error).not.toBeInstanceOf(ViewError);
    expect(error.rpcError).toBeNull();
    expect(error.message).toContain("tried https://a.test, https://b.test");
    expect(error.message).toContain("last error: network error: fetch failed (ECONNRESET)");
    expect(error.message).toContain("after 4 attempts");
    expect(error.cause).toBe(original);
  });

  it("uses a plain Error cause when the last failure was an HTTP status", async () => {
    const { rpc } = client(["https://a.test"], [() => json({}, 503)], [], { maxRounds: 1 });
    const error = (await rpc.viewAccount("a.testnet").catch((e: unknown) => e)) as RpcError;
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe("HTTP 503");
  });

  it("keeps API keys out of messages and attempts by naming origins only", async () => {
    const secret = "https://a.test/v3/SECRETKEY?apiKey=SECRETQUERY";
    const { rpc } = client([secret], [() => json({}, 500)], [], { maxRounds: 1 });
    const error = (await rpc.viewAccount("a.testnet").catch((e: unknown) => e)) as RpcError;
    expect(error.message).toContain("(tried https://a.test)");
    expect(JSON.stringify(error.attempts)).not.toContain("SECRET");
    expect(error.message).not.toContain("SECRET");
    expect(rpc.currentUrl).toBe(secret);
  });

  it("keeps attempts, raw rpcError and cause on a ViewError built after a failover", async () => {
    const panic = {
      name: "HANDLER_ERROR",
      cause: { name: "CONTRACT_EXECUTION_ERROR" },
      data: "PROBARION:Frozen",
    };
    const { rpc } = client(
      ["https://a.test", "https://b.test"],
      [() => json({}, 503), () => json({ jsonrpc: "2.0", id: "1", error: panic })],
    );
    const error = (await rpc
      .viewFunction("vault.testnet", "check_spend")
      .catch((e: unknown) => e)) as ViewError;
    expect(error).toBeInstanceOf(ViewError);
    expect(error.probarionCode).toBe("Frozen");
    expect(error.attempts).toEqual([{ url: "https://a.test", error: "HTTP 503" }]);
    expect(error.rpcError).toEqual(panic);
    expect(error.cause).toBeInstanceOf(RpcError);
  });
});

// ---------- 4xx from one endpoint ----------

describe("endpoint 4xx fails over (401, 403, 404)", () => {
  it.each([401, 403, 404])("moves on from HTTP %i to the next URL", async (status) => {
    const { rpc, calls, sleeps } = client(
      ["https://a.test", "https://b.test"],
      [() => json({ error: "nope" }, status), ok({ result: bytesOf({ fine: true }), logs: [] })],
    );
    expect(await rpc.viewFunction("vault.testnet", "get_config")).toEqual({ fine: true });
    expect(calls.map((c) => c.url)).toEqual(["https://a.test", "https://b.test"]);
    expect(rpc.currentUrl).toBe("https://b.test");
    expect(sleeps).toEqual([100]);
  });

  it("throws a transport RpcError, never a ViewError, when every endpoint answers 403", async () => {
    const { rpc, calls } = client(
      ["https://a.test", "https://b.test"],
      [() => json({ error: "forbidden" }, 403)],
    );
    const error = (await rpc
      .viewFunction("vault.testnet", "get_config")
      .catch((e: unknown) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error).not.toBeInstanceOf(ViewError);
    expect(error.rpcError).toBeNull();
    expect(error.attempts).toHaveLength(4);
    expect(error.attempts.every((a) => a.error === "HTTP 403")).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it("treats any other HTTP failure (400) as final transport failure, not a ViewError", async () => {
    const { rpc, calls } = client(
      ["https://a.test", "https://b.test"],
      [() => new Response("bad request body", { status: 400 })],
    );
    const error = (await rpc
      .viewFunction("vault.testnet", "x")
      .catch((e: unknown) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error).not.toBeInstanceOf(ViewError);
    expect(error.rpcError).toBeNull();
    expect(error.message).toContain("HTTP 400: bad request body");
    expect(calls).toHaveLength(1);
  });

  it.each([503, 403])(
    "cancels the unread body of a failed-over HTTP %i response",
    async (status) => {
      let cancelled = 0;
      const withBody = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("unread"));
            },
            cancel() {
              cancelled += 1;
            },
          }),
          { status },
        );
      const { rpc } = client(
        ["https://a.test", "https://b.test"],
        [withBody, ok({ result: bytesOf(1), logs: [] })],
      );
      expect(await rpc.viewFunction("vault.testnet", "x")).toBe(1);
      expect(cancelled).toBe(1);
    },
  );
});

// ---------- Retry-After (M3) ----------

describe("Retry-After parsing", () => {
  const withHeader = async (header: string | undefined, overrides = {}) => {
    const sleeps: number[] = [];
    const headers: Record<string, string> = header === undefined ? {} : { "retry-after": header };
    const { rpc } = client(
      ["https://a.test", "https://b.test"],
      [() => json({}, 429, headers), ok({ result: bytesOf(0), logs: [] })],
      sleeps,
      overrides,
    );
    await rpc.viewFunction("vault.testnet", "x");
    return sleeps;
  };

  it.each([
    ["an empty header", ""],
    ["a blank header", "   "],
    ["a non-numeric header", "soon"],
    ["a negative header", "-5"],
    ["zero", "0"],
    ["a date in the past", "Wed, 21 Oct 2015 07:28:00 GMT"],
  ])("falls back to the backoff delay for %s, never to 0", async (_name, header) => {
    expect(await withHeader(header)).toEqual([100]);
  });

  it("reads delay-seconds, including a fractional value", async () => {
    expect(await withHeader("2", { maxDelayMs: 10_000 })).toEqual([2000]);
    expect(await withHeader("1.5", { maxDelayMs: 10_000 })).toEqual([1500]);
  });

  it("reads an HTTP-date", async () => {
    const date = new Date(Date.now() + 30_000).toUTCString();
    const [sleep] = await withHeader(date, { maxDelayMs: 60_000 });
    expect(sleep).toBeGreaterThan(25_000);
    expect(sleep).toBeLessThanOrEqual(30_000);
  });

  it("caps an HTTP-date at maxDelayMs", async () => {
    const date = new Date(Date.now() + 3_600_000).toUTCString();
    expect(await withHeader(date)).toEqual([1000]);
  });

  it("uses the backoff delay when no header is sent", async () => {
    expect(await withHeader(undefined)).toEqual([100]);
  });
});

// ---------- constructor validation (M5) ----------

describe("maxRounds validation", () => {
  it.each([0, 11, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects maxRounds %s",
    (maxRounds) => {
      expect(() => new RpcClient({ urls: ["https://a.test"], maxRounds })).toThrow(ConfigError);
    },
  );

  it.each([1, 3, 10])("accepts maxRounds %i", (maxRounds) => {
    expect(() => new RpcClient({ urls: ["https://a.test"], maxRounds })).not.toThrow();
  });

  it("defaults to 3 rounds", async () => {
    const { rpc, calls } = client(["https://a.test"], [() => json({}, 500)], [], {
      maxRounds: undefined,
    });
    await rpc.viewAccount("a.testnet").catch(() => undefined);
    expect(calls).toHaveLength(3);
  });
});

// ---------- behaviour pins (M7) ----------

describe("timeouts, backoff cap and no-retry rules (M7)", () => {
  let silent: Server;
  let silentUrl = "";

  beforeAll(async () => {
    // Accepts connections and never answers.
    silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const address = silent.address();
    if (address === null || typeof address === "string") throw new Error("no ephemeral port");
    silentUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    silent.closeAllConnections();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  it("aborts a request that outlives timeoutMs and reports the timeout", async () => {
    const rpc = new RpcClient({
      urls: [silentUrl],
      maxRounds: 2,
      timeoutMs: 100,
      sleep: async () => {},
    });
    const started = Date.now();
    const error = (await rpc.viewAccount("a.testnet").catch((e: unknown) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error.attempts).toHaveLength(2);
    expect(error.attempts.map((a) => a.error)).toEqual([
      "network error: timed out after 100ms",
      "network error: timed out after 100ms",
    ]);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("grows the backoff by doubling until it reaches maxDelayMs and stays there", async () => {
    const { rpc, sleeps } = client(["https://a.test"], [() => json({}, 500)], [], { maxRounds: 7 });
    await rpc.viewAccount("a.testnet").catch(() => undefined);
    expect(sleeps).toEqual([100, 200, 400, 800, 1000, 1000]);
  });

  it("does not retry or fail over on a contract panic (legacy and modern shapes)", async () => {
    const legacy = client(
      ["https://a.test", "https://b.test"],
      [ok({ error: "Smart contract panicked: PROBARION:NoMandate", logs: [] })],
    );
    await expect(legacy.rpc.viewFunction("vault.testnet", "check_spend")).rejects.toThrow(
      ViewError,
    );
    expect(legacy.calls).toHaveLength(1);
    const modern = client(
      ["https://a.test", "https://b.test"],
      [
        () =>
          json({
            jsonrpc: "2.0",
            id: "1",
            error: {
              name: "HANDLER_ERROR",
              cause: { name: "CONTRACT_EXECUTION_ERROR" },
              data: "PROBARION:Frozen",
            },
          }),
      ],
    );
    await expect(modern.rpc.viewFunction("vault.testnet", "check_spend")).rejects.toThrow(
      ViewError,
    );
    expect(modern.calls).toHaveLength(1);
    expect(modern.sleeps).toEqual([]);
  });

  it("does not retry or fail over on UNKNOWN_ACCESS_KEY", async () => {
    const { rpc, calls, sleeps } = client(
      ["https://a.test", "https://b.test"],
      [
        () =>
          json({
            jsonrpc: "2.0",
            id: "1",
            error: {
              name: "HANDLER_ERROR",
              cause: { name: "UNKNOWN_ACCESS_KEY", info: { public_key: "ed25519:K" } },
            },
          }),
      ],
    );
    const error = (await rpc
      .call("query", {
        request_type: "view_access_key",
        finality: "final",
        account_id: "a",
        public_key: "ed25519:K",
      })
      .catch((e: unknown) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect((error.rpcError as { cause: { name: string } }).cause.name).toBe("UNKNOWN_ACCESS_KEY");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});
