import type { SpendRequest } from "@probarion/core";
import { sha256Bytes } from "@probarion/core";
import {
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  encodeTransaction,
  JsonRpcProvider,
  KeyPairSigner,
  type KeyPairString,
  type Provider,
  type SignedTransaction,
} from "near-api-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProbarionError, TxOutcomeUnknownError } from "../src/errors.js";
import { RpcClient } from "../src/rpc.js";
import {
  createScenarioChain,
  type FakeChain,
  type FakeRpcServer,
  GAS_FLOOR_INTENTS_PAYOUT,
  GAS_FLOOR_NEAR_PAYOUT,
  SCENARIO_CODE_HASH,
  SCENARIO_VAULT,
  type ScenarioOptions,
  startFakeRpcServer,
  TEST_KEYS,
} from "../src/testing/index.js";
import { NearApiJsSender } from "../src/tx.js";
import { SPEND_GAS, VaultClient } from "../src/vault-client.js";

const request: SpendRequest = {
  mandate_id: 1,
  amount: "25000000",
  invoice_hash: "ab".repeat(32),
  ref: "INV-1",
  decision_hash: "cd".repeat(32),
};

let server: FakeRpcServer;
const extra: FakeRpcServer[] = [];

beforeEach(async () => {
  server = await startFakeRpcServer(createScenarioChain());
});

afterEach(async () => {
  await server.close();
  for (const s of extra.splice(0)) await s.close();
});

async function serverFor(opts: ScenarioOptions): Promise<FakeRpcServer> {
  const s = await startFakeRpcServer(createScenarioChain(opts));
  extra.push(s);
  return s;
}

function vault(): VaultClient {
  const rpc = new RpcClient({ urls: [server.url] });
  return new VaultClient(SCENARIO_VAULT, rpc, {
    agent: new NearApiJsSender({
      accountId: SCENARIO_VAULT,
      secretKey: TEST_KEYS.agent.secretKey,
      rpcUrl: server.url,
    }),
    ledger: new NearApiJsSender({
      accountId: SCENARIO_VAULT,
      secretKey: TEST_KEYS.ledger.secretKey,
      rpcUrl: server.url,
    }),
  });
}

interface TxResult {
  final_execution_status: string;
  status: unknown;
  transaction: { hash: string };
  transaction_outcome: { outcome: { receipt_ids: string[] } };
  receipts_outcome: { id: string }[];
}

async function rawRpc(
  url: string,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, params }),
  });
  return (await res.json()) as Record<string, unknown>;
}

/**
 * A real sender whose provider hands every signed transaction to `sink` before sending it. `waitUntil` overrides the
 * level the sender asks for (it always asks for FINAL), to see what a sender does with an answer given earlier.
 */
function recordingSender(
  url: string,
  secretKey: string,
  accountId: string,
  sink: SignedTransaction[],
  waitUntil?: Parameters<JsonRpcProvider["sendTransactionUntil"]>[1],
): NearApiJsSender {
  return new NearApiJsSender({
    accountId,
    secretKey,
    rpcUrl: url,
    createProvider: (providerUrl): Provider => {
      const inner = new JsonRpcProvider({ url: providerUrl });
      return new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === "sendTransactionUntil") {
            return (
              signed: SignedTransaction,
              asked: Parameters<JsonRpcProvider["sendTransactionUntil"]>[1],
            ) => {
              sink.push(signed);
              return target.sendTransactionUntil(signed, waitUntil ?? asked);
            };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    },
  });
}

describe("NearApiJsSender against the fake JSON-RPC server (127.0.0.1)", () => {
  it("signs and sends spend with the agent FC key", async () => {
    const { tx, result } = await vault().spend(request);
    expect(tx.ok).toBe(true);
    expect(typeof tx.txHash).toBe("string");
    expect(result).toEqual({ spend_id: 1, status: "paid" });
    expect(server.chain.spends[0]?.ref).toBe("INV-1");
    expect(server.methods).toContain("block");
  });

  it("returns the vault code when the contract panics", async () => {
    server.chain.hooks.spendPanic = "DuplicateRef";
    const { tx, result } = await vault().spend(request);
    expect(tx).toMatchObject({ ok: false, code: "DuplicateRef" });
    expect(result).toBeNull();
  });

  it("anchors with the ledger key and records a retrievable tx", async () => {
    const out = await vault().anchor(1, "ab".repeat(32), 1);
    expect(server.chain.anchors).toHaveLength(1);
    const rpc = new RpcClient({ urls: [server.url] });
    const status = await rpc.txStatus(out.txHash ?? "", SCENARIO_VAULT);
    expect(status.receipts_outcome[0]?.outcome.logs[0]).toContain("ledger_anchored");
  });

  it("cannot call anchor with the spend-only agent key", async () => {
    const agentOnly = new NearApiJsSender({
      accountId: SCENARIO_VAULT,
      secretKey: TEST_KEYS.agent.secretKey,
      rpcUrl: server.url,
    });
    await expect(
      agentOnly.functionCall({
        receiverId: SCENARIO_VAULT,
        methodName: "anchor",
        args: { seq: 1, root: "ab".repeat(32), count: 1 },
        gas: 15_000_000_000_000n,
        deposit: 0n,
      }),
    ).rejects.toThrow(ProbarionError);
    expect(server.chain.anchors).toHaveLength(0);
  });

  it("sends consecutive transactions on one key (the nonce moves on) and gives each a distinct 32-byte hash", async () => {
    const v = vault();
    const first = await v.spend(request);
    const second = await v.spend({ ...request, invoice_hash: "ef".repeat(32), ref: "INV-2" });
    expect(second.result).toEqual({ spend_id: 2, status: "paid" });
    expect(first.tx.txHash).not.toBe(second.tx.txHash);
    expect(baseDecode(first.tx.txHash ?? "")).toHaveLength(32);
  });

  it("burns for an Intents payee and reports the burn receipts through the real tx RPC (stub shape)", async () => {
    const { tx, result } = await vault().spend({ ...request, mandate_id: 2, ref: "B-1" });
    expect(result).toEqual({ spend_id: 1, status: "burned" });
    const status = await new RpcClient({ urls: [server.url] }).txStatus(
      tx.txHash ?? "",
      SCENARIO_VAULT,
    );
    const burn = status.receipts_outcome.find((r) =>
      r.outcome.logs.some((l) => l.includes('"ft_burn"')),
    );
    expect(burn?.outcome.executor_id).toBe(server.chain.config.intents);
    expect(burn?.outcome.logs).toHaveLength(2); // mt_burn and ft_burn in one receipt, like tx 3u4ffrwp... on testnet
    expect(burn?.outcome.logs[0]).toContain('"mt_burn"');
  });

  it("burns in the mainnet shape on request: two receipts, the second executed by the POA asset", async () => {
    const mainnet = await serverFor({ burnShape: "mainnet" });
    const sender = new NearApiJsSender({
      accountId: SCENARIO_VAULT,
      secretKey: TEST_KEYS.agent.secretKey,
      rpcUrl: mainnet.url,
    });
    const v = new VaultClient(SCENARIO_VAULT, new RpcClient({ urls: [mainnet.url] }), {
      agent: sender,
    });
    const { tx } = await v.spend({ ...request, mandate_id: 2, ref: "B-1" });
    const status = await new RpcClient({ urls: [mainnet.url] }).txStatus(
      tx.txHash ?? "",
      SCENARIO_VAULT,
    );
    const mt = status.receipts_outcome.find((r) =>
      r.outcome.logs.some((l) => l.includes('"mt_burn"')),
    );
    const ft = status.receipts_outcome.find((r) =>
      r.outcome.logs.some((l) => l.includes('"ft_burn"')),
    );
    expect(mt?.outcome.executor_id).toBe(mainnet.chain.config.intents);
    expect(ft?.outcome.executor_id).toBe(mainnet.chain.config.allowed_assets[0]);
    expect(mt?.id).not.toBe(ft?.id);
  });

  it("approves a held spend with the approver's full-access key and one yocto", async () => {
    const held = await vault().spend({ ...request, amount: "75000000" });
    expect(held.result).toEqual({ spend_id: 1, status: "held" });
    const approver = new NearApiJsSender({
      accountId: "approver.testnet",
      secretKey: TEST_KEYS.approver.secretKey,
      rpcUrl: server.url,
    });
    const noDeposit = await approver.functionCall({
      receiverId: SCENARIO_VAULT,
      methodName: "approve",
      args: { spend_id: 1 },
      gas: SPEND_GAS,
      deposit: 0n,
    });
    expect(noDeposit).toMatchObject({ ok: false, code: "RequiresOneYocto" });
    const out = await approver.functionCall({
      receiverId: SCENARIO_VAULT,
      methodName: "approve",
      args: { spend_id: 1 },
      gas: SPEND_GAS,
      deposit: 1n,
    });
    expect(out).toMatchObject({ ok: true, value: { spend_id: 1, status: "paid" } });
    expect(server.chain.spends[0]?.status).toBe("paid");
  });

  it("refuses a function-call key that attaches a deposit, like a node does", async () => {
    const agentKey = new NearApiJsSender({
      accountId: SCENARIO_VAULT,
      secretKey: TEST_KEYS.agent.secretKey,
      rpcUrl: server.url,
    });
    await expect(
      agentKey.functionCall({
        receiverId: SCENARIO_VAULT,
        methodName: "spend",
        args: { request },
        gas: SPEND_GAS,
        deposit: 1n,
      }),
    ).rejects.toThrow(ProbarionError);
    expect(server.chain.spends).toHaveLength(0);
  });

  it("recovers from a transient endpoint failure (failNext) through the RpcClient failover", async () => {
    const rpc = new RpcClient({ urls: [server.url], sleep: async () => {} });
    server.failNext([503]);
    const before = server.methods.length;
    const config = await rpc.viewFunction<{ owner: string }>(SCENARIO_VAULT, "get_config");
    expect(config.owner).toBe("owner.testnet");
    expect(server.methods.length - before).toBe(2);
  });
});

describe("the fake server speaks the strict response shapes of the real RpcClient (Task 8)", () => {
  it("viewAccount: decimal-string balances, an integer storage_usage, and no global hash for a local deploy", async () => {
    const local = await serverFor({ codeMode: "local" });
    const account = await new RpcClient({ urls: [local.url] }).viewAccount(SCENARIO_VAULT);
    expect(account).toMatchObject({ code_hash: SCENARIO_CODE_HASH, global_contract_hash: null });
    expect(account.amount).toMatch(/^\d+$/);
    expect(account.locked).toMatch(/^\d+$/);
    expect(Number.isInteger(account.storage_usage)).toBe(true);
    const raw = await rawRpc(local.url, "query", {
      request_type: "view_account",
      finality: "final",
      account_id: SCENARIO_VAULT,
    });
    const result = raw.result as Record<string, unknown>;
    expect(typeof result.amount).toBe("string");
    expect(typeof result.locked).toBe("string");
    expect(typeof result.storage_usage).toBe("number");
    expect("global_contract_hash" in result).toBe(false); // RPC omits it for an account that runs its own code
  });

  it("viewAccount: a global-mode vault has the all-ones code hash and reports global_contract_hash (R6)", async () => {
    const global = await serverFor({ codeMode: "global" });
    const account = await new RpcClient({ urls: [global.url] }).viewAccount(SCENARIO_VAULT);
    expect(account.code_hash).toBe("11111111111111111111111111111111");
    expect(account.global_contract_hash).toBe(SCENARIO_CODE_HASH);
    const raw = (
      await rawRpc(global.url, "query", {
        request_type: "view_account",
        finality: "final",
        account_id: SCENARIO_VAULT,
      })
    ).result as Record<string, unknown>;
    expect(raw.global_contract_hash).toBe(SCENARIO_CODE_HASH);
  });

  it("viewAccount: an unknown account is the node's UNKNOWN_ACCOUNT error, not a made-up account", async () => {
    await expect(
      new RpcClient({ urls: [server.url] }).viewAccount("ghost.testnet"),
    ).rejects.toThrow(/UNKNOWN_ACCOUNT|does not exist/);
  });

  it("viewFunction: reads the config, a mandate page, a verdict and a contract panic", async () => {
    const rpc = new RpcClient({ urls: [server.url] });
    const v = new VaultClient(SCENARIO_VAULT, rpc);
    expect((await v.getConfig()).ledger_key).toBe(TEST_KEYS.ledger.publicKey);
    expect((await v.listAllMandates()).map((m) => m.id)).toEqual([1, 2]);
    expect(await v.getMandate(1)).toMatchObject({ id: 1, status: "active", spent: "0" });
    expect(await v.getMandate(0)).toBeNull();
    expect(await v.checkSpend(request, TEST_KEYS.agent.publicKey)).toEqual({
      ok: true,
      code: null,
      would_hold: false,
    });
    expect((await v.checkSpend({ ...request, amount: "0" }, TEST_KEYS.agent.publicKey)).code).toBe(
      "ZeroAmount",
    );
    // A request the contract cannot deserialize is a failed view (a panic text), as on a real node.
    await expect(
      v.checkSpend({ ...request, amount: "abc" }, TEST_KEYS.agent.publicKey),
    ).rejects.toThrow(/deserialize/);
    await expect(rpc.viewFunction(SCENARIO_VAULT, "no_such_method")).rejects.toThrow(
      /MethodNotFound/,
    );
  });

  it("viewAccessKeyList: the agent and the ledger keys are the only keys, each a one-method FC key on the vault (ICR-5)", async () => {
    const keys = await new RpcClient({ urls: [server.url] }).viewAccessKeyList(SCENARIO_VAULT);
    expect(keys).toEqual([
      {
        public_key: TEST_KEYS.agent.publicKey,
        permission: {
          receiver_id: SCENARIO_VAULT,
          method_names: ["spend"],
          allowance: expect.stringMatching(/^\d+$/),
        },
      },
      {
        public_key: TEST_KEYS.ledger.publicKey,
        permission: {
          receiver_id: SCENARIO_VAULT,
          method_names: ["anchor"],
          allowance: expect.stringMatching(/^\d+$/),
        },
      },
    ]);
  });

  it("txStatus: every field the strict mapper needs, for a paid spend, a panic and an anchor", async () => {
    const v = vault();
    const rpc = new RpcClient({ urls: [server.url] });
    const paid = await v.spend(request);
    const status = await rpc.txStatus(paid.tx.txHash ?? "", SCENARIO_VAULT);
    expect(status.transaction).toMatchObject({
      hash: paid.tx.txHash,
      signer_id: SCENARIO_VAULT,
      receiver_id: SCENARIO_VAULT,
    });
    expect(status.transaction_outcome.outcome.executor_id).toBe(SCENARIO_VAULT);
    expect(status.status).toMatchObject({ SuccessValue: expect.any(String) });
    expect(status.receipts_outcome.length).toBeGreaterThan(1);
    for (const r of status.receipts_outcome) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.outcome.executor_id).toBe("string");
    }
    // The vault receipt comes first and carries spend_submitted; the callback carries spend_paid.
    expect(status.receipts_outcome[0]?.outcome.executor_id).toBe(SCENARIO_VAULT);
    expect(status.receipts_outcome[0]?.outcome.logs[0]).toContain('"spend_submitted"');
    expect(
      status.receipts_outcome.some((r) => r.outcome.logs.some((l) => l.includes('"spend_paid"'))),
    ).toBe(true);
    expect(
      status.receipts_outcome.some((r) => r.outcome.executor_id === server.chain.config.usdc),
    ).toBe(true);

    server.chain.hooks.spendPanic = "Frozen";
    const refused = await v.spend({ ...request, ref: "INV-9" });
    const failed = await rpc.txStatus(refused.tx.txHash ?? "", SCENARIO_VAULT);
    expect(JSON.stringify(failed.status)).toContain("PROBARION:Frozen");
    expect(failed.receipts_outcome[0]?.outcome.status).toMatchObject({
      Failure: expect.anything(),
    });
  });

  it("txStatus: an unknown hash is the node's UNKNOWN_TRANSACTION error", async () => {
    await expect(
      new RpcClient({ urls: [server.url] }).txStatus(
        baseEncode(new Uint8Array(32)),
        SCENARIO_VAULT,
      ),
    ).rejects.toThrow(/UNKNOWN_TRANSACTION|not found/);
  });

  it("answers `tx` and EXPERIMENTAL_tx_status alike, with a first receipt whose id the transaction outcome names", async () => {
    const { tx } = await vault().spend(request);
    const params = { tx_hash: tx.txHash, sender_account_id: SCENARIO_VAULT, wait_until: "FINAL" };
    const a = (await rawRpc(server.url, "tx", params)).result as TxResult;
    const b = (await rawRpc(server.url, "EXPERIMENTAL_tx_status", params)).result as TxResult;
    expect(a.transaction.hash).toBe(tx.txHash);
    expect(b.transaction.hash).toBe(tx.txHash);
    expect(a.transaction_outcome.outcome.receipt_ids).toEqual([a.receipts_outcome[0]?.id]);
    expect(typeof a.status).toBe("object");
    expect(a.final_execution_status).toBe("FINAL");
  });
});

describe("the stub-shape burn matches a live testnet transaction", () => {
  // Read once, read-only, from https://archival-rpc.testnet.fastnear.com (method `tx`, wait_until NONE):
  // tx 3u4ffrwpiwLoNV6cU72NHLVBAMq729NwLs6ixDLdcvYe, a Base spend on v0.probarion.testnet.
  // Each row: [executor role, number of logs, status kind, number of receipt ids].
  const LIVE_LAYOUT = [
    ["vault", 1, "SuccessReceiptId", 3], // spend: spend_submitted, returns the promise
    ["intents", 2, "SuccessValue", 1], // intents-stub ft_withdraw: mt_burn AND ft_burn in one receipt
    ["vault", 0, "SuccessValue", 0], // gas refund of the payout receipt
    ["vault", 1, "SuccessValue", 1], // on_withdraw: spend_burned
    ["vault", 0, "SuccessValue", 0], // gas refund of the callback
    ["vault", 0, "SuccessValue", 0], // gas refund of the spend receipt
  ];
  const LIVE_TX_KEYS = [
    "actions",
    "hash",
    "nonce",
    "priority_fee",
    "public_key",
    "receiver_id",
    "signature",
    "signer_id",
  ];

  it("has the same receipt layout, logs and field names as the live transaction", async () => {
    const { tx, result } = await vault().spend({ ...request, mandate_id: 2, ref: "B-1" });
    expect(result).toEqual({ spend_id: 1, status: "burned" });
    const raw = (
      await rawRpc(server.url, "tx", {
        tx_hash: tx.txHash,
        sender_account_id: SCENARIO_VAULT,
        wait_until: "FINAL",
      })
    ).result as {
      transaction: Record<string, unknown>;
      receipts_outcome: {
        outcome: { executor_id: string; logs: string[]; status: object; receipt_ids: string[] };
      }[];
    };
    const role = (executor: string) =>
      executor === SCENARIO_VAULT
        ? "vault"
        : executor === server.chain.config.intents
          ? "intents"
          : executor;
    expect(
      raw.receipts_outcome.map((r) => [
        role(r.outcome.executor_id),
        r.outcome.logs.length,
        Object.keys(r.outcome.status)[0],
        r.outcome.receipt_ids.length,
      ]),
    ).toEqual(LIVE_LAYOUT);
    expect(Object.keys(raw.transaction).sort()).toEqual(LIVE_TX_KEYS);
  });
});

describe("the fake server enforces what a node enforces before a contract runs", () => {
  const send = (signed: SignedTransaction) =>
    rawRpc(server.url, "send_tx", {
      signed_tx_base64: Buffer.from(encodeTransaction(signed)).toString("base64"),
      wait_until: "FINAL",
    });

  it("answers the very same signed transaction sent again with its stored outcome, and runs nothing twice (nearcore send_tx_internal)", async () => {
    const sink: SignedTransaction[] = [];
    const sender = recordingSender(server.url, TEST_KEYS.agent.secretKey, SCENARIO_VAULT, sink);
    const out = await sender.functionCall({
      receiverId: SCENARIO_VAULT,
      methodName: "spend",
      args: { request },
      gas: SPEND_GAS,
      deposit: 0n,
    });
    expect(out.ok).toBe(true);
    const signed = sink[0];
    if (signed === undefined) throw new Error("no transaction was recorded");

    const again = await send(signed);
    expect(again.error).toBeUndefined();
    expect((again.result as { transaction: { hash: string } }).transaction.hash).toBe(out.txHash);
    expect(server.chain.spends).toHaveLength(1);
    expect(server.chain.accessKey(SCENARIO_VAULT, TEST_KEYS.agent.publicKey)?.nonce).toBe(
      Number(signed.transaction.nonce),
    );
  });

  it("refuses a different transaction on a used nonce (InvalidNonce) and a tampered signature (InvalidSignature)", async () => {
    const sink: SignedTransaction[] = [];
    const sender = recordingSender(server.url, TEST_KEYS.agent.secretKey, SCENARIO_VAULT, sink);
    await sender.functionCall({
      receiverId: SCENARIO_VAULT,
      methodName: "spend",
      args: { request },
      gas: SPEND_GAS,
      deposit: 0n,
    });
    const signed = sink[0];
    if (signed === undefined) throw new Error("no transaction was recorded");

    const t = signed.transaction;
    const clone = createTransaction(
      t.signerId,
      t.publicKey,
      t.receiverId,
      t.nonce,
      [
        actions.functionCall(
          "spend",
          { request: { ...request, ref: "INV-2", invoice_hash: "ef".repeat(32) } },
          SPEND_GAS,
          0n,
        ),
      ],
      t.blockHash,
    );
    const { signedTransaction: different } = await KeyPairSigner.fromSecretKey(
      TEST_KEYS.agent.secretKey as KeyPairString,
    ).signTransaction(clone);
    expect(JSON.stringify((await send(different)).error)).toContain("InvalidNonce");
    expect(server.chain.spends).toHaveLength(1);

    const sig = signed.signature.ed25519Signature?.data;
    if (sig === undefined) throw new Error("not an ed25519 signature");
    sig[0] = (sig[0] ?? 0) ^ 1;
    const tampered = await send(signed);
    expect(JSON.stringify(tampered.error)).toContain("InvalidSignature");
    expect(server.chain.spends).toHaveLength(1);
  });

  it("uses the transaction hash a node computes: sha256 of the unsigned transaction bytes", async () => {
    const sink: SignedTransaction[] = [];
    const sender = recordingSender(server.url, TEST_KEYS.agent.secretKey, SCENARIO_VAULT, sink);
    const out = await sender.functionCall({
      receiverId: SCENARIO_VAULT,
      methodName: "spend",
      args: { request },
      gas: SPEND_GAS,
      deposit: 0n,
    });
    const signed = sink[0];
    if (signed === undefined) throw new Error("no transaction was recorded");
    expect(out.txHash).toBe(baseEncode(sha256Bytes(encodeTransaction(signed.transaction))));
  });
});

describe("tx lookups are routed by the SIGNER (sender_account_id), like a node's shards", () => {
  const unknownTx = /UNKNOWN_TRANSACTION/;

  it("finds a vault-signed spend only under the vault and an approval only under the approver", async () => {
    const spent = await vault().spend({ ...request, amount: "75000000" });
    expect(spent.result).toEqual({ spend_id: 1, status: "held" });
    const approverSender = new NearApiJsSender({
      accountId: "approver.testnet",
      secretKey: TEST_KEYS.approver.secretKey,
      rpcUrl: server.url,
    });
    const approved = await approverSender.functionCall({
      receiverId: SCENARIO_VAULT,
      methodName: "approve",
      args: { spend_id: 1 },
      gas: SPEND_GAS,
      deposit: 1n,
    });
    const spendHash = spent.tx.txHash ?? "";
    const approveHash = approved.txHash ?? "";
    expect(approved.ok).toBe(true);

    const rpc = new RpcClient({ urls: [server.url] });
    await expect(rpc.txStatus(spendHash, "approver.testnet")).rejects.toThrow(unknownTx);
    await expect(rpc.txStatus(approveHash, SCENARIO_VAULT)).rejects.toThrow(unknownTx);
    await expect(rpc.txStatus(approveHash, "someone-else.testnet")).rejects.toThrow(unknownTx);
    expect((await rpc.txStatus(spendHash, SCENARIO_VAULT)).transaction.signer_id).toBe(
      SCENARIO_VAULT,
    );
    expect((await rpc.txStatus(approveHash, "approver.testnet")).transaction.signer_id).toBe(
      "approver.testnet",
    );
  });

  it("makes a collector try the vault first and then each approver, as Task 14's burn collection does", async () => {
    await vault().spend({ ...request, amount: "75000000" });
    const approverSender = new NearApiJsSender({
      accountId: "approver.testnet",
      secretKey: TEST_KEYS.approver.secretKey,
      rpcUrl: server.url,
    });
    const approved = await approverSender.functionCall({
      receiverId: SCENARIO_VAULT,
      methodName: "approve",
      args: { spend_id: 1 },
      gas: SPEND_GAS,
      deposit: 1n,
    });
    const rpc = new RpcClient({ urls: [server.url] });
    const config = server.chain.config;
    const before = server.methods.filter((m) => m === "tx").length;
    let found: string | null = null;
    const tried: string[] = [];
    for (const account of [SCENARIO_VAULT, ...config.approvers]) {
      tried.push(account);
      try {
        found = (await rpc.txStatus(approved.txHash ?? "", account)).transaction.signer_id;
        break;
      } catch (error) {
        if (!unknownTx.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
    expect(found).toBe("approver.testnet");
    expect(tried).toEqual([SCENARIO_VAULT, "approver.testnet"]);
    expect(server.methods.filter((m) => m === "tx").length - before).toBe(2);
  });

  it("answers a node's error object for an unknown transaction and a parse error without sender_account_id", async () => {
    const { tx } = await vault().spend(request);
    const wrong = await rawRpc(server.url, "tx", {
      tx_hash: tx.txHash,
      sender_account_id: "approver.testnet",
      wait_until: "FINAL",
    });
    expect(wrong.error).toMatchObject({
      name: "HANDLER_ERROR",
      cause: { name: "UNKNOWN_TRANSACTION", info: { requested_transaction_hash: tx.txHash } },
    });
    for (const method of ["tx", "EXPERIMENTAL_tx_status"]) {
      const missing = await rawRpc(server.url, method, { tx_hash: tx.txHash, wait_until: "FINAL" });
      expect(missing.error).toMatchObject({
        name: "REQUEST_VALIDATION_ERROR",
        cause: { name: "PARSE_ERROR" },
      });
      const wrongLevel = await rawRpc(server.url, method, {
        tx_hash: tx.txHash,
        sender_account_id: SCENARIO_VAULT,
        wait_until: "SOON",
      });
      expect(wrongLevel.error).toMatchObject({ name: "REQUEST_VALIDATION_ERROR" });
    }
  });
});

describe("recovery after a send whose answer never arrived (TxOutcomeUnknownError, then resolveSpend)", () => {
  /** Run `send` and return what it threw, which must be a TxOutcomeUnknownError. */
  async function unknownOf(send: () => Promise<unknown>): Promise<TxOutcomeUnknownError> {
    const error = await send().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TxOutcomeUnknownError);
    return error as TxOutcomeUnknownError;
  }

  function client(sink: SignedTransaction[], waitUntil?: "NONE" | "INCLUDED" | "INCLUDED_FINAL") {
    return new VaultClient(SCENARIO_VAULT, new RpcClient({ urls: [server.url] }), {
      agent: recordingSender(
        server.url,
        TEST_KEYS.agent.secretKey,
        SCENARIO_VAULT,
        sink,
        waitUntil,
      ),
    });
  }

  it("a response lost after the node stored the transaction: the hash is the client's own and resolveSpend reads the real verdict", async () => {
    const sink: SignedTransaction[] = [];
    const v = client(sink);
    server.dropNextResponses(1);
    const unknown = await unknownOf(() => v.spend(request));

    // The transaction DID run: the node stored it under the hash the client computed before sending.
    expect(server.chain.spends).toHaveLength(1);
    const signed = sink[0];
    if (signed === undefined) throw new Error("no transaction was recorded");
    const clientHash = baseEncode(sha256Bytes(encodeTransaction(signed.transaction)));
    expect(unknown.txHash).toBe(clientHash);
    expect(unknown.signerId).toBe(SCENARIO_VAULT);
    expect(server.chain.txs.has(clientHash)).toBe(true);
    expect(server.methods.filter((m) => m === "send_tx")).toHaveLength(1); // it was not sent again

    const resolved = await v.resolveSpend(unknown.txHash);
    expect(resolved).toMatchObject({
      ok: true,
      unconfirmed: null,
      result: { spend_id: 1, status: "paid" },
    });
    expect(resolved.tx.txHash).toBe(clientHash);
    expect(server.chain.spends).toHaveLength(1); // resolving read the outcome, it did not spend again
  });

  it("recovers a held spend as held, a refused spend with its contract code, and a failed payout as ok:false", async () => {
    const held = client([]);
    server.dropNextResponses(1);
    const heldUnknown = await unknownOf(() => held.spend({ ...request, amount: "75000000" }));
    expect(await held.resolveSpend(heldUnknown.txHash)).toMatchObject({
      ok: true,
      result: { spend_id: 1, status: "held" },
    });

    server.chain.hooks.spendPanic = "DuplicateRef";
    server.dropNextResponses(1);
    const refusedUnknown = await unknownOf(() => held.spend({ ...request, ref: "INV-2" }));
    const refused = await held.resolveSpend(refusedUnknown.txHash);
    expect(refused).toMatchObject({ ok: false, unconfirmed: null, result: null });
    expect(refused.tx.code).toBe("DuplicateRef");

    server.chain.hooks.spendPanic = null;
    server.chain.hooks.payoutFailure = "ft_transfer_failed";
    server.dropNextResponses(1);
    const failedUnknown = await unknownOf(() =>
      held.spend({ ...request, ref: "INV-3", invoice_hash: "ef".repeat(32) }),
    );
    const failed = await held.resolveSpend(failedUnknown.txHash);
    // The callback that records the failure succeeds, so the transaction is ok but the spend did not pay.
    expect(failed.tx.ok).toBe(true);
    expect(failed).toMatchObject({ ok: false, unconfirmed: null, result: { status: "failed" } });
  });

  it("an answer given before the transaction is final (wait_until NONE or INCLUDED) is an unknown outcome too, and the call still ran", async () => {
    for (const level of ["NONE", "INCLUDED"] as const) {
      const fresh = await serverFor({});
      const sink: SignedTransaction[] = [];
      const v = new VaultClient(SCENARIO_VAULT, new RpcClient({ urls: [fresh.url] }), {
        agent: recordingSender(fresh.url, TEST_KEYS.agent.secretKey, SCENARIO_VAULT, sink, level),
      });
      const unknown = await unknownOf(() => v.spend(request));
      expect(unknown.message).toMatch(/before the transaction was final/);
      expect(fresh.chain.spends).toHaveLength(1);
      // Looking the hash up asks for FINAL, which the fake already has.
      expect(await v.resolveSpend(unknown.txHash)).toMatchObject({
        ok: true,
        result: { spend_id: 1, status: "paid" },
      });
    }
  });

  it("answers a transaction that is already final in full at every wait_until level, and rejects an unknown level", async () => {
    const sink: SignedTransaction[] = [];
    await recordingSender(server.url, TEST_KEYS.agent.secretKey, SCENARIO_VAULT, sink).functionCall(
      {
        receiverId: SCENARIO_VAULT,
        methodName: "spend",
        args: { request },
        gas: SPEND_GAS,
        deposit: 0n,
      },
    );
    const signed = sink[0];
    if (signed === undefined) throw new Error("no transaction was recorded");
    const sendAt = async (wait_until: string) =>
      (
        await rawRpc(server.url, "send_tx", {
          signed_tx_base64: Buffer.from(encodeTransaction(signed)).toString("base64"),
          wait_until,
        })
      ).result as Record<string, unknown>;
    // The tx is final already, so every level gets the full outcome.
    for (const level of ["NONE", "INCLUDED", "EXECUTED_OPTIMISTIC", "FINAL"]) {
      expect((await sendAt(level)).status).toBeDefined();
    }
    expect(
      (await rawRpc(server.url, "send_tx", { signed_tx_base64: "AAAA", wait_until: "SOON" })).error,
    ).toMatchObject({
      name: "REQUEST_VALIDATION_ERROR",
    });
  });
});

describe("prepaid gas, through the real sender", () => {
  const TGAS = 1_000_000_000_000n;

  it("SPEND_GAS covers both payout kinds", () => {
    expect(SPEND_GAS).toBeGreaterThanOrEqual(GAS_FLOOR_NEAR_PAYOUT);
    expect(SPEND_GAS).toBeGreaterThanOrEqual(GAS_FLOOR_INTENTS_PAYOUT);
  });

  it("a spend with too little gas fails like a node's ExecutionError, reserves nothing, and still uses the nonce", async () => {
    const sender = new NearApiJsSender({
      accountId: SCENARIO_VAULT,
      secretKey: TEST_KEYS.agent.secretKey,
      rpcUrl: server.url,
    });
    const low = await sender.functionCall({
      receiverId: SCENARIO_VAULT,
      methodName: "spend",
      args: { request },
      gas: 20n * TGAS,
      deposit: 0n,
    });
    expect(low).toMatchObject({ ok: false, code: null });
    expect(low.failure).toContain("Exceeded the prepaid gas");
    expect(server.chain.spends).toHaveLength(0);
    expect(server.chain.mandates[0]).toMatchObject({ reserved: "0", uses: 0 });

    const base = await sender.functionCall({
      receiverId: SCENARIO_VAULT,
      methodName: "spend",
      args: { request: { ...request, mandate_id: 2 } },
      gas: 100n * TGAS,
      deposit: 0n,
    });
    expect(base.failure).toContain("Exceeded the prepaid gas"); // an Intents payout needs 115 Tgas
    const enough = await sender.functionCall({
      receiverId: SCENARIO_VAULT,
      methodName: "spend",
      args: { request },
      gas: SPEND_GAS,
      deposit: 0n,
    });
    expect(enough).toMatchObject({ ok: true, value: { spend_id: 1, status: "paid" } });
  });
});

describe("servers are independent and bound to loopback", () => {
  it("binds 127.0.0.1 only and keeps one chain per server", async () => {
    const other = await serverFor({});
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(other.url).not.toBe(server.url);
    const chain: FakeChain = other.chain;
    expect(chain).not.toBe(server.chain);
  });
});
