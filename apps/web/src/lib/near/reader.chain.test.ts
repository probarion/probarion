import type { AnchorView, SpendView } from "@probarion/core";
import { NETWORKS } from "@probarion/core";
import { RpcClient, RpcError } from "@probarion/sdk";
import {
  createScenarioChain,
  type FakeChain,
  SCENARIO_APPROVER,
  SCENARIO_NEAR_PAYEE,
  SCENARIO_VAULT,
  startFakeRpcServer,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { startChainRpc } from "../../../test/fixtures/rpc";
import { chainErrorKind, createVaultReader, listAll } from "./reader";

// The reader against the SDK's fake chain and fake JSON-RPC server: real node response shapes over
// real (loopback) HTTP, so these reads go through the same parsing a live vault does.

const T = NETWORKS.testnet;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function start(chain: FakeChain = createScenarioChain()) {
  const c = await startChainRpc(chain);
  closers.push(c.close);
  return { ...c, reader: createVaultReader(c.rpc) };
}

/** Two providers over one chain, for failover. */
async function startPair(chain: FakeChain = createScenarioChain()) {
  const first = await startFakeRpcServer(chain);
  const second = await startFakeRpcServer(chain);
  closers.push(
    () => first.close(),
    () => second.close(),
  );
  const rpc = new RpcClient({ urls: [first.url, second.url], sleep: async () => {} });
  return { first, second, chain, reader: createVaultReader(rpc) };
}

const spend = (id: number, status: SpendView["status"] = "paid"): SpendView => ({
  id,
  mandate_id: 1,
  amount: "1000000",
  invoice_hash: id.toString(16).padStart(64, "0"),
  ref: `ref-${id}`,
  decision_hash: "d".repeat(64),
  agent_pk: TEST_KEYS.agent.publicKey,
  destination: { type: "near", account_id: SCENARIO_NEAR_PAYEE },
  status,
  created_at_ns: "1793750400000000000",
  held_until_ns: null,
  memo: null,
});

const anchor = (seq: number): AnchorView => ({
  seq,
  root: seq.toString(16).padStart(64, "a"),
  count: seq * 2,
  at_ns: "1793750400000000000",
  ledger_key: TEST_KEYS.ledger.publicKey,
});

describe("vault views", () => {
  it("reads the config, mandates and agents", async () => {
    const { reader, chain } = await start();
    expect(await reader.getConfig(SCENARIO_VAULT)).toEqual(chain.config);
    const mandates = await reader.listMandates(SCENARIO_VAULT, 0, 50);
    expect(mandates.map((m) => m.id)).toEqual([1, 2]);
    expect(mandates[1]?.payee).toMatchObject({ type: "intents", chain: "base" });
    expect(await reader.listAgents(SCENARIO_VAULT)).toEqual([
      { public_key: TEST_KEYS.agent.publicKey, label: "TEST DOUBLE agent", added_at_ns: "0" },
    ]);
  });

  it("pages spends and anchors with listAll over a 0-based from_index", async () => {
    const chain = createScenarioChain();
    chain.spends = Array.from({ length: 230 }, (_, i) => spend(i + 1));
    chain.anchors = Array.from({ length: 3 }, (_, i) => anchor(i + 1));
    const { reader, server } = await start(chain);
    const spends = await listAll((from, limit) => reader.listSpends(SCENARIO_VAULT, from, limit));
    expect(spends.map((s) => s.id)).toEqual(Array.from({ length: 230 }, (_, i) => i + 1));
    expect(server.methods).toHaveLength(5); // 50 + 50 + 50 + 50 + 30
    const anchors = await listAll((from, limit) => reader.listAnchors(SCENARIO_VAULT, from, limit));
    expect(anchors.map((a) => a.seq)).toEqual([1, 2, 3]);
  });

  it("stops on an empty page after a run of exactly full pages", async () => {
    const chain = createScenarioChain();
    chain.spends = Array.from({ length: 100 }, (_, i) => spend(i + 1));
    const { reader, server } = await start(chain);
    const spends = await listAll((from, limit) => reader.listSpends(SCENARIO_VAULT, from, limit));
    expect(spends).toHaveLength(100);
    expect(server.methods).toHaveLength(3); // 50 + 50 + an empty page
  });
});

describe("contract errors", () => {
  it("maps a missing vault, a missing contract and a missing view to contract", async () => {
    const { reader, chain } = await start();
    const unknown = await reader.getConfig("nobody.testnet").catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(RpcError);
    expect(chainErrorKind(unknown)).toBe("contract");
    // An existing account that has no contract.
    const noCode = await reader.getConfig(chain.config.owner).catch((e: unknown) => e);
    expect(chainErrorKind(noCode)).toBe("contract");
    // A contract that has no such view.
    const noMethod = await reader.listAgents(chain.config.usdc).catch((e: unknown) => e);
    expect(chainErrorKind(noMethod)).toBe("contract");
  });

  it("maps a view that panics to contract", async () => {
    const { rpc } = await start();
    // get_mandate without its argument: the contract's JSON deserialisation panics.
    const panic = await rpc
      .viewFunction(SCENARIO_VAULT, "get_mandate", {})
      .catch((e: unknown) => e);
    expect(panic).toBeInstanceOf(RpcError);
    expect(String(panic)).toMatch(/panicked/);
    expect(chainErrorKind(panic)).toBe("contract");
  });
});

describe("balances", () => {
  it("reads the vault's USDC balance", async () => {
    const chain = createScenarioChain();
    chain.ftBalances = { [T.usdc]: { [SCENARIO_VAULT]: "20208197" } };
    const { reader } = await start(chain);
    expect(await reader.ftBalance(T.usdc, SCENARIO_VAULT)).toBe("20208197");
    expect(await reader.ftBalance(T.usdc, "someone.testnet")).toBe("0");
  });

  it("reads the vault's Intents balance of the Base asset", async () => {
    const { reader } = await start(createScenarioChain({ intentsBalance: "2500000" }));
    expect(await reader.intentsBalance(T.intents, SCENARIO_VAULT, T.allowedAssets.base)).toBe(
      "2500000",
    );
    // An asset the vault holds nothing of, and an account that is not the vault.
    expect(await reader.intentsBalance(T.intents, SCENARIO_VAULT, T.allowedAssets.solana)).toBe(
      "0",
    );
    expect(await reader.intentsBalance(T.intents, "someone.testnet", T.allowedAssets.base)).toBe(
      "0",
    );
  });
});

describe("access keys", () => {
  it("reads the agent's and the ledger's keys as the vault granted them", async () => {
    const { reader, chain } = await start();
    expect(await reader.accessKey(SCENARIO_VAULT, TEST_KEYS.agent.publicKey)).toEqual({
      exists: true,
      kind: "FunctionCall",
      fullAccess: false,
      allowance: "1000000000000000000000000",
      receiverId: SCENARIO_VAULT,
      methodNames: ["spend"],
    });
    expect(await reader.accessKey(SCENARIO_VAULT, String(chain.config.ledger_key))).toEqual({
      exists: true,
      kind: "FunctionCall",
      fullAccess: false,
      allowance: "250000000000000000000000",
      receiverId: SCENARIO_VAULT,
      methodNames: ["anchor"],
    });
  });

  it("reads a full-access key and a missing key", async () => {
    const { reader } = await start();
    const approver = await reader.accessKey(SCENARIO_APPROVER, TEST_KEYS.approver.publicKey);
    expect(approver).toMatchObject({ exists: true, kind: "FullAccess", fullAccess: true });
    const missing = await reader.accessKey(SCENARIO_VAULT, TEST_KEYS.other.publicKey);
    expect(missing).toMatchObject({ exists: false, kind: null, fullAccess: false });
    expect((await reader.accessKey("nobody.testnet", TEST_KEYS.other.publicKey)).exists).toBe(
      false,
    );
  });

  it("sees a full-access key left on the vault", async () => {
    const chain = createScenarioChain();
    chain.addAccessKey(SCENARIO_VAULT, {
      public_key: TEST_KEYS.other.publicKey,
      permission: "FullAccess",
    });
    const { reader } = await start(chain);
    expect(await reader.accessKey(SCENARIO_VAULT, TEST_KEYS.other.publicKey)).toMatchObject({
      exists: true,
      kind: "FullAccess",
      fullAccess: true,
    });
  });
});

describe("factory and accounts", () => {
  it("reads the factory config", async () => {
    const { reader, chain } = await start();
    const config = await reader.factoryConfig(T.factory);
    expect(config).toEqual(chain.factory?.config);
    expect(config.min_deposit).toBe("5000000000000000000000000");
    expect(config.current_version).toBe(1);
  });

  it("tells an existing account from an unknown one", async () => {
    const { reader } = await start();
    expect(await reader.accountExists(SCENARIO_VAULT)).toBe(true);
    expect(await reader.accountExists(SCENARIO_APPROVER)).toBe(true);
    expect(await reader.accountExists("free-name.vaults.probarion.testnet")).toBe(false);
  });

  it("reads a global-contract vault (R6) and a vault with its own code alike", async () => {
    for (const codeMode of ["global", "local"] as const) {
      const { reader, rpc } = await start(createScenarioChain({ codeMode }));
      expect(await reader.accountExists(SCENARIO_VAULT)).toBe(true);
      const account = await rpc.viewAccount(SCENARIO_VAULT);
      expect(account.global_contract_hash === null).toBe(codeMode === "local");
    }
  });
});

describe("failover across two real servers", () => {
  it("answers from the second provider when the first is overloaded, then keeps using it", async () => {
    const { first, second, reader, chain } = await startPair();
    first.failNext([429]);
    expect((await reader.getConfig(SCENARIO_VAULT)).owner).toBe(chain.config.owner);
    expect(first.methods).toHaveLength(1);
    expect(second.methods).toHaveLength(1);

    // The healthy provider stays preferred: the next read does not go back to the first.
    await reader.getConfig(SCENARIO_VAULT);
    expect(first.methods).toHaveLength(1);
    expect(second.methods).toHaveLength(2);
  });

  it("does not ask the second provider about an account the first says is unknown", async () => {
    const { first, second, reader } = await startPair();
    expect(await reader.accountExists("free-name.vaults.probarion.testnet")).toBe(false);
    expect(first.methods).toHaveLength(1);
    expect(second.methods).toHaveLength(0);
  });
});
