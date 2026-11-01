import { describe, expect, it } from "vitest";
import { RpcError, ViewError } from "../src/errors.js";
import { RpcClient, resolveRpcUrls } from "../src/rpc.js";
import { bytesOf, client, json, ok, scripted } from "./helpers/rpc-fakes.js";

describe("RpcClient failover and backoff", () => {
  it("fails over on HTTP 429 and honours Retry-After", async () => {
    const { rpc, calls, sleeps } = client(
      ["https://a.test", "https://b.test"],
      [
        () => json({ error: "rate limited" }, 429, { "retry-after": "1" }),
        ok({ result: bytesOf({ ok: true }), logs: [] }),
      ],
    );
    expect(await rpc.viewFunction("vault.testnet", "get_config")).toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual(["https://a.test", "https://b.test"]);
    expect(sleeps).toEqual([1000]);
    expect(rpc.currentUrl).toBe("https://b.test");
  });

  it("retries 5xx, network errors, HTML bodies and JSON-RPC timeouts", async () => {
    const sleeps: number[] = [];
    const s = scripted([
      () => json({}, 503),
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("<html>502 Bad Gateway</html>", { status: 200 }),
      () =>
        json({
          jsonrpc: "2.0",
          id: "1",
          error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } },
        }),
      ok({ result: bytesOf(7), logs: [] }),
    ]);
    const rpc = new RpcClient({
      urls: ["https://a.test", "https://b.test"],
      fetch: s.fetchFn,
      maxRounds: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(rpc.currentUrl).toBe("https://a.test");
    expect(await rpc.viewFunction("vault.testnet", "x")).toBe(7);
    expect(s.calls.map((c) => c.url)).toEqual([
      "https://a.test",
      "https://b.test",
      "https://a.test",
      "https://b.test",
      "https://a.test",
    ]);
    expect(sleeps).toEqual([100, 200, 400, 800]);
  });

  it("treats HTTP 408, NO_SYNCED_BLOCKS and a response without result as transport failures", async () => {
    const { rpc, calls } = client(
      ["https://a.test", "https://b.test"],
      [
        () => json({}, 408),
        () =>
          json({
            jsonrpc: "2.0",
            id: "1",
            error: { name: "HANDLER_ERROR", cause: { name: "NO_SYNCED_BLOCKS" } },
          }),
        () => json({ jsonrpc: "2.0", id: "1" }),
        ok({ result: bytesOf(true), logs: [] }),
      ],
    );
    expect(await rpc.viewFunction("vault.testnet", "x")).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it("throws a non-transient JSON-RPC error at once", async () => {
    const { rpc, calls } = client(
      ["https://a.test", "https://b.test"],
      [
        () =>
          json({
            jsonrpc: "2.0",
            id: "1",
            error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } },
          }),
      ],
    );
    await expect(rpc.viewAccount("nobody.testnet")).rejects.toThrow(RpcError);
    expect(calls).toHaveLength(1);
  });

  it("gives up after maxRounds over every URL and lists the attempts", async () => {
    const { rpc } = client(["https://a.test", "https://b.test"], [() => json({}, 500)]);
    const error = await rpc.viewAccount("vault.testnet").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).attempts).toHaveLength(4);
  });

  it("starts the next call at the last URL that succeeded", async () => {
    const { rpc, calls } = client(
      ["https://a.test", "https://b.test"],
      [
        () => json({}, 503),
        ok({ result: bytesOf(1), logs: [] }),
        ok({ result: bytesOf(2), logs: [] }),
      ],
    );
    expect(await rpc.viewFunction("vault.testnet", "x")).toBe(1);
    expect(await rpc.viewFunction("vault.testnet", "x")).toBe(2);
    expect(calls.map((c) => c.url)).toEqual(["https://a.test", "https://b.test", "https://b.test"]);
  });

  it("caps Retry-After at maxDelayMs", async () => {
    const { rpc, sleeps } = client(
      ["https://a.test", "https://b.test"],
      [() => json({}, 429, { "retry-after": "60" }), ok({ result: bytesOf(0), logs: [] })],
    );
    await rpc.viewFunction("vault.testnet", "x");
    expect(sleeps).toEqual([1000]);
  });
});

describe("RpcClient views", () => {
  it("encodes call_function args and decodes the result bytes", async () => {
    const { rpc, calls } = client(
      ["https://a.test"],
      [ok({ result: bytesOf([{ id: 0 }]), logs: [] })],
    );
    expect(
      await rpc.viewFunction("vault.testnet", "list_mandates", { from_index: 0, limit: 50 }),
    ).toEqual([{ id: 0 }]);
    const params = calls[0]?.params ?? {};
    expect(params).toMatchObject({
      request_type: "call_function",
      finality: "final",
      account_id: "vault.testnet",
      method_name: "list_mandates",
    });
    expect(JSON.parse(Buffer.from(String(params.args_base64), "base64").toString("utf8"))).toEqual({
      from_index: 0,
      limit: 50,
    });
  });

  it("returns null for an Option::None view", async () => {
    const { rpc } = client(["https://a.test"], [ok({ result: bytesOf(null), logs: [] })]);
    expect(await rpc.viewFunction("vault.testnet", "get_mandate", { mandate_id: 9 })).toBeNull();
  });

  it("maps view panics in both RPC shapes to ViewError with the vault code", async () => {
    const legacy = client(
      ["https://a.test"],
      [
        ok({
          error: "wasm execution failed: Smart contract panicked: PROBARION:NoMandate",
          logs: [],
        }),
      ],
    );
    const legacyError = await legacy.rpc
      .viewFunction("vault.testnet", "check_spend")
      .catch((e: unknown) => e);
    expect(legacyError).toBeInstanceOf(ViewError);
    expect((legacyError as ViewError).probarionCode).toBe("NoMandate");
    const modern = client(
      ["https://a.test"],
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
    const modernError = await modern.rpc
      .viewFunction("vault.testnet", "check_spend")
      .catch((e: unknown) => e);
    expect((modernError as ViewError).probarionCode).toBe("Frozen");
  });

  it("maps access keys, treating unknown permission kinds as FullAccess", async () => {
    const { rpc } = client(
      ["https://a.test"],
      [
        ok({
          keys: [
            { public_key: "ed25519:A", access_key: { nonce: 1, permission: "FullAccess" } },
            {
              public_key: "ed25519:B",
              access_key: {
                nonce: 1,
                permission: {
                  FunctionCall: {
                    allowance: "100",
                    receiver_id: "vault.testnet",
                    method_names: ["spend"],
                  },
                },
              },
            },
            {
              public_key: "ed25519:C",
              access_key: {
                nonce: 1,
                permission: {
                  FunctionCall: {
                    allowance: null,
                    receiver_id: "vault.testnet",
                    method_names: ["anchor"],
                  },
                },
              },
            },
            {
              public_key: "ed25519:D",
              access_key: { nonce: 1, permission: { GasKeyFunctionCall: {} } },
            },
          ],
        }),
      ],
    );
    expect(await rpc.viewAccessKeyList("vault.testnet")).toEqual([
      { public_key: "ed25519:A", permission: "FullAccess" },
      {
        public_key: "ed25519:B",
        permission: { receiver_id: "vault.testnet", method_names: ["spend"], allowance: "100" },
      },
      {
        public_key: "ed25519:C",
        permission: { receiver_id: "vault.testnet", method_names: ["anchor"], allowance: null },
      },
      { public_key: "ed25519:D", permission: "FullAccess" },
    ]);
  });

  it("reads code_hash and tx status", async () => {
    const { rpc, calls } = client(
      ["https://a.test"],
      [
        ok({ amount: "1", locked: "0", code_hash: "Hash111", storage_usage: 100 }),
        ok({
          status: { SuccessValue: "" },
          transaction: { hash: "Tx1", signer_id: "vault.testnet", receiver_id: "vault.testnet" },
          transaction_outcome: {
            id: "Tx1",
            outcome: { logs: [], receipt_ids: ["R1"], executor_id: "vault.testnet", status: {} },
          },
          receipts_outcome: [
            {
              id: "R1",
              outcome: {
                logs: ["EVENT_JSON:{}"],
                receipt_ids: [],
                executor_id: "token.testnet",
                status: {},
              },
            },
          ],
        }),
      ],
    );
    expect((await rpc.viewAccount("vault.testnet")).code_hash).toBe("Hash111");
    const tx = await rpc.txStatus("Tx1", "vault.testnet");
    expect(tx.receipts_outcome[0]?.outcome).toMatchObject({
      executor_id: "token.testnet",
      logs: ["EVENT_JSON:{}"],
    });
    expect(calls[1]).toMatchObject({
      method: "tx",
      params: { tx_hash: "Tx1", sender_account_id: "vault.testnet", wait_until: "FINAL" },
    });
  });
});

describe("viewAccount global_contract_hash (R6, NEP-591)", () => {
  it("maps a global-contract account to its global_contract_hash alongside code_hash", async () => {
    const { rpc, calls } = client(
      ["https://a.test"],
      [
        ok({
          amount: "5",
          locked: "0",
          code_hash: "11111111111111111111111111111111",
          global_contract_hash: "GlobalHash222",
          storage_usage: 182,
        }),
      ],
    );
    const account = await rpc.viewAccount("probarion-1.vaults.probarion.testnet");
    expect(account).toEqual({
      amount: "5",
      locked: "0",
      code_hash: "11111111111111111111111111111111",
      global_contract_hash: "GlobalHash222",
      storage_usage: 182,
    });
    expect(calls[0]?.params).toMatchObject({
      request_type: "view_account",
      finality: "final",
      account_id: "probarion-1.vaults.probarion.testnet",
    });
  });

  it("maps an absent global_contract_hash to null for a plain-deploy account", async () => {
    const { rpc } = client(
      ["https://a.test"],
      [ok({ amount: "1", locked: "0", code_hash: "Hash111", storage_usage: 100 })],
    );
    const account = await rpc.viewAccount("v0.probarion.testnet");
    expect(account.code_hash).toBe("Hash111");
    expect(account.global_contract_hash).toBeNull();
    expect("global_contract_hash" in account).toBe(true);
  });

  it("maps an explicit null global_contract_hash to null", async () => {
    const { rpc } = client(
      ["https://a.test"],
      [
        ok({
          amount: "1",
          locked: "0",
          code_hash: "Hash111",
          global_contract_hash: null,
          storage_usage: 100,
        }),
      ],
    );
    expect((await rpc.viewAccount("v0.probarion.testnet")).global_contract_hash).toBeNull();
  });

  it("rejects a global_contract_hash of the wrong type instead of guessing", async () => {
    const { rpc } = client(
      ["https://a.test"],
      [
        ok({
          amount: "1",
          locked: "0",
          code_hash: "Hash111",
          global_contract_hash: 42,
          storage_usage: 100,
        }),
      ],
    );
    await expect(rpc.viewAccount("v0.probarion.testnet")).rejects.toThrow(/malformed/);
  });
});

describe("resolveRpcUrls", () => {
  it("prefers explicit URLs, then NEAR_RPC_URLS, then the network defaults", () => {
    expect(resolveRpcUrls("testnet", ["https://x.test"], {})).toEqual(["https://x.test"]);
    expect(
      resolveRpcUrls("testnet", undefined, { NEAR_RPC_URLS: " https://a.test, https://b.test ," }),
    ).toEqual(["https://a.test", "https://b.test"]);
    expect(resolveRpcUrls("mainnet", undefined, {})).toEqual([
      "https://rpc.mainnet.fastnear.com",
      "https://rpc.intea.rs",
    ]);
  });

  it("treats an empty or whitespace-only NEAR_RPC_URLS as unset (R12)", () => {
    const testnet = ["https://rpc.testnet.fastnear.com"];
    expect(resolveRpcUrls("testnet", undefined, { NEAR_RPC_URLS: "" })).toEqual(testnet);
    expect(resolveRpcUrls("testnet", undefined, { NEAR_RPC_URLS: "   " })).toEqual(testnet);
    expect(resolveRpcUrls("testnet", undefined, { NEAR_RPC_URLS: " , ," })).toEqual(testnet);
    expect(resolveRpcUrls("testnet", [], { NEAR_RPC_URLS: "" })).toEqual(testnet);
  });

  it("rejects an empty URL list", () => {
    expect(() => new RpcClient({ urls: [] })).toThrow();
  });
});
