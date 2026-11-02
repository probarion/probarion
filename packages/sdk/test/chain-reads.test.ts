// Task 14 carries A (SDK fixes 1-4 from the web review, R6 code identity): chain reads fail closed and read the
// answers real nodes give. Everything runs against scripted fetches or the loopback fake RPC server.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RpcError, ViewError } from "../src/errors.js";
import { IntentsClient } from "../src/intents-client.js";
import { codeIdentity, RpcClient } from "../src/rpc.js";
import {
  createScenarioChain,
  type FakeRpcServer,
  SCENARIO_CODE_HASH,
  SCENARIO_VAULT,
  startFakeRpcServer,
  TEST_KEYS,
} from "../src/testing/index.js";
import { NearApiJsSender } from "../src/tx.js";
import { VaultClient } from "../src/vault-client.js";
import { bytesOf, client, json, ok } from "./helpers/rpc-fakes.js";

const BLOCK = { block_height: 1, block_hash: "Block111" };

/** A JSON-RPC error answer with this `name` and `cause.name`. */
const rpcError = (name: string, cause: string) => () =>
  json({
    jsonrpc: "2.0",
    id: "1",
    error: { name, cause: { name: cause, info: {} }, code: -32000 },
  });

describe("IntentsClient.poaBalance (fix 2)", () => {
  it("throws on a null answer: mt_balance_of always returns a U128 string, so null is never a zero", async () => {
    const { rpc } = client(["https://a.test"], [ok({ result: bytesOf(null), logs: [], ...BLOCK })]);
    await expect(
      new IntentsClient("intents.near", rpc).poaBalance("a.near", "x.near"),
    ).rejects.toThrow(ViewError);
    const { rpc: zero } = client(
      ["https://a.test"],
      [ok({ result: bytesOf("0"), logs: [], ...BLOCK })],
    );
    expect(await new IntentsClient("intents.near", zero).poaBalance("a.near", "x.near")).toBe(0n);
  });
});

describe("missing accounts and keys, in both node answers (fix 3)", () => {
  const legacy = (text: string) => ok({ error: text, logs: [], ...BLOCK });

  it("viewAccessKey: a key, then null for a missing key in the legacy 200 form and the structured form", async () => {
    const permission = {
      FunctionCall: { allowance: null, receiver_id: "v.testnet", method_names: ["spend"] },
    };
    const found = client(["https://a.test"], [ok({ nonce: 7, permission, ...BLOCK })]);
    expect(await found.rpc.viewAccessKey("v.testnet", "ed25519:K")).toEqual({
      public_key: "ed25519:K",
      permission: { receiver_id: "v.testnet", method_names: ["spend"], allowance: null },
    });
    expect(found.calls[0]?.params).toMatchObject({
      request_type: "view_access_key",
      public_key: "ed25519:K",
    });
    for (const answer of [
      legacy("access key ed25519:K does not exist while viewing"),
      rpcError("HANDLER_ERROR", "UNKNOWN_ACCESS_KEY"),
      legacy("account v.testnet does not exist while viewing"),
      rpcError("HANDLER_ERROR", "UNKNOWN_ACCOUNT"),
    ]) {
      const { rpc, calls } = client(["https://a.test", "https://b.test"], [answer]);
      expect(await rpc.viewAccessKey("v.testnet", "ed25519:K")).toBeNull();
      expect(calls).toHaveLength(1); // a definite answer about the target: no failover
    }
  });

  it("viewAccessKey: any other result.error, and an unknown permission, throw (never a missing key)", async () => {
    const other = client(["https://a.test"], [legacy("some other node complaint")]);
    await expect(other.rpc.viewAccessKey("v.testnet", "ed25519:K")).rejects.toThrow(ViewError);
    const odd = client(
      ["https://a.test"],
      [ok({ nonce: 1, permission: { NewKind: {} }, ...BLOCK })],
    );
    await expect(odd.rpc.viewAccessKey("v.testnet", "ed25519:K")).rejects.toThrow(/permission/);
  });

  it("viewAccount and viewAccessKeyList read a legacy 200 missing account as UNKNOWN_ACCOUNT", async () => {
    for (const read of [
      (rpc: RpcClient) => rpc.viewAccount("ghost.testnet"),
      (rpc: RpcClient) => rpc.viewAccessKeyList("ghost.testnet"),
    ]) {
      const { rpc } = client(
        ["https://a.test"],
        [legacy("account ghost.testnet does not exist while viewing")],
      );
      const error = (await read(rpc).catch((e: unknown) => e)) as RpcError;
      expect(error).toBeInstanceOf(RpcError);
      expect(error.message).toContain("does not exist");
      expect((error.rpcError as { cause: { name: string } }).cause.name).toBe("UNKNOWN_ACCOUNT");
      const structured = client(["https://a.test"], [rpcError("HANDLER_ERROR", "UNKNOWN_ACCOUNT")]);
      const same = (await read(structured.rpc).catch((e: unknown) => e)) as RpcError;
      expect((same.rpcError as { cause: { name: string } }).cause.name).toBe("UNKNOWN_ACCOUNT");
    }
    const garbled = client(["https://a.test"], [legacy("something else")]);
    await expect(garbled.rpc.viewAccount("a.testnet")).rejects.toThrow(/malformed result/);
  });
});

describe("read failover on node-side errors (fix 4)", () => {
  const cases: [string, string, string][] = [
    ["INTERNAL_ERROR", "INTERNAL_ERROR", "INTERNAL_ERROR"],
    ["UNAVAILABLE_SHARD", "HANDLER_ERROR", "UNAVAILABLE_SHARD"],
    ["NOT_SYNCED_YET", "HANDLER_ERROR", "NOT_SYNCED_YET"],
  ];
  const account = { amount: "1", locked: "0", code_hash: "Hash111", storage_usage: 1 };

  it.each(cases)(
    "a query answered %s fails over to the next endpoint",
    async (_label, name, cause) => {
      const { rpc, calls } = client(
        ["https://a.test", "https://b.test"],
        [rpcError(name, cause), ok(account)],
      );
      expect((await rpc.viewAccount("a.testnet")).code_hash).toBe("Hash111");
      expect(calls.map((c) => c.url)).toEqual(["https://a.test", "https://b.test"]);
    },
  );

  it.each(cases)("a tx lookup answered %s fails over too", async (_label, name, cause) => {
    const { rpc, calls } = client(
      ["https://a.test", "https://b.test"],
      [rpcError(name, cause), rpcError("HANDLER_ERROR", "UNKNOWN_TRANSACTION")],
    );
    await expect(rpc.txStatus("T", "a.testnet")).rejects.toThrow(RpcError);
    expect(calls.map((c) => c.url)).toEqual(["https://a.test", "https://b.test"]);
  });

  it.each(cases)(
    "a transaction send answered %s is final: it is never resent",
    async (_label, name, cause) => {
      for (const method of ["send_tx", "broadcast_tx_commit", "broadcast_tx_async"]) {
        const { rpc, calls } = client(
          ["https://a.test", "https://b.test"],
          [rpcError(name, cause), ok({})],
        );
        const error = (await rpc
          .call(method, { signed_tx_base64: "AA==" })
          .catch((e: unknown) => e)) as RpcError;
        expect(error, method).toBeInstanceOf(RpcError);
        expect((error.rpcError as { cause: { name: string } }).cause.name).toBe(cause);
        expect(calls, method).toHaveLength(1);
      }
    },
  );

  it("still treats a contract answer (UNKNOWN_ACCOUNT, a panic) as final for reads", async () => {
    const { rpc, calls } = client(
      ["https://a.test", "https://b.test"],
      [rpcError("HANDLER_ERROR", "UNKNOWN_ACCOUNT"), ok(account)],
    );
    await expect(rpc.viewAccount("a.testnet")).rejects.toThrow(RpcError);
    expect(calls).toHaveLength(1);
  });
});

describe("codeIdentity (R6): global_contract_hash ?? code_hash", () => {
  const view = { amount: "1", locked: "0", storage_usage: 1 };
  it("is the global contract hash for a global-mode account and the code hash otherwise", () => {
    expect(
      codeIdentity({
        ...view,
        code_hash: "11111111111111111111111111111111",
        global_contract_hash: "GlobalHash",
      }),
    ).toBe("GlobalHash");
    expect(codeIdentity({ ...view, code_hash: "LocalHash", global_contract_hash: null })).toBe(
      "LocalHash",
    );
  });
});

describe("the fake RPC server answers missing keys and accounts as nodes do", () => {
  let server: FakeRpcServer;
  const extra: FakeRpcServer[] = [];
  beforeEach(async () => {
    server = await startFakeRpcServer(createScenarioChain());
  });
  afterEach(async () => {
    await server.close();
    for (const s of extra.splice(0)) await s.close();
  });

  async function raw(
    url: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "query", params }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  it("a missing access key is HTTP 200 with result.error and the block fields (default), or the structured error", async () => {
    const params = {
      request_type: "view_access_key",
      finality: "final",
      account_id: SCENARIO_VAULT,
      public_key: TEST_KEYS.other.publicKey,
    };
    const legacy = await raw(server.url, params);
    expect(legacy.error).toBeUndefined();
    expect(legacy.result).toMatchObject({
      error: `access key ${TEST_KEYS.other.publicKey} does not exist while viewing`,
      block_height: server.chain.height,
      block_hash: server.chain.blockHash,
    });
    const structuredServer = await startFakeRpcServer(createScenarioChain(), {
      missingAccessKey: "structured",
    });
    extra.push(structuredServer);
    const structured = await raw(structuredServer.url, params);
    expect(structured.result).toBeUndefined();
    expect(structured.error).toMatchObject({ cause: { name: "UNKNOWN_ACCESS_KEY" } });
    for (const url of [server.url, structuredServer.url]) {
      const rpc = new RpcClient({ urls: [url] });
      expect(await rpc.viewAccessKey(SCENARIO_VAULT, TEST_KEYS.other.publicKey)).toBeNull();
      expect(await rpc.viewAccessKey(SCENARIO_VAULT, TEST_KEYS.agent.publicKey)).toMatchObject({
        permission: { receiver_id: SCENARIO_VAULT, method_names: ["spend"] },
      });
    }
  });

  it("a missing account can be answered in the legacy form too, and the SDK reads it as UNKNOWN_ACCOUNT", async () => {
    const legacyServer = await startFakeRpcServer(createScenarioChain(), {
      missingAccount: "legacy",
    });
    extra.push(legacyServer);
    const answer = await raw(legacyServer.url, {
      request_type: "view_account",
      finality: "final",
      account_id: "ghost.testnet",
    });
    expect(answer.result).toMatchObject({
      error: "account ghost.testnet does not exist while viewing",
    });
    const error = (await new RpcClient({ urls: [legacyServer.url] })
      .viewAccount("ghost.testnet")
      .catch((e: unknown) => e)) as RpcError;
    expect((error.rpcError as { cause: { name: string } }).cause.name).toBe("UNKNOWN_ACCOUNT");
  });

  it("a sender whose key is not on the vault sends nothing, in both answer forms", async () => {
    const structuredServer = await startFakeRpcServer(createScenarioChain(), {
      missingAccessKey: "structured",
    });
    extra.push(structuredServer);
    for (const s of [server, structuredServer]) {
      const sender = new NearApiJsSender({
        accountId: SCENARIO_VAULT,
        secretKey: TEST_KEYS.other.secretKey,
        rpcUrl: s.url,
      });
      const vault = new VaultClient(SCENARIO_VAULT, new RpcClient({ urls: [s.url] }), {
        agent: sender,
      });
      const before = s.chain.txs.size;
      const error = await vault
        .spend({
          mandate_id: 1,
          amount: "1",
          invoice_hash: "ab".repeat(32),
          ref: "R",
          decision_hash: "cd".repeat(32),
        })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "TxSendFailed" });
      expect(s.chain.txs.size).toBe(before);
    }
  });

  it("a global-mode vault's code identity is the global contract hash, a local one its own code hash", async () => {
    const local = await startFakeRpcServer(createScenarioChain({ codeMode: "local" }));
    extra.push(local);
    expect(
      codeIdentity(await new RpcClient({ urls: [server.url] }).viewAccount(SCENARIO_VAULT)),
    ).toBe(SCENARIO_CODE_HASH);
    expect(
      codeIdentity(await new RpcClient({ urls: [local.url] }).viewAccount(SCENARIO_VAULT)),
    ).toBe(SCENARIO_CODE_HASH);
    expect(
      (await new RpcClient({ urls: [server.url] }).viewAccount(SCENARIO_VAULT)).code_hash,
    ).not.toBe(SCENARIO_CODE_HASH);
  });
});
