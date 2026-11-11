import {
  NearAiProposer,
  type ProbarionDeps,
  RpcClient,
  RpcError,
  type TxOutcome,
  type TxSender,
} from "@probarion/sdk";
import { TEST_KEYS } from "@probarion/sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payablesBudget } from "./budget";

// The SDK instance of a console upload, with makeTenantProbarion replaced: what it is given, and how the parts that run
// before the first transaction keep to the cycle's time while nothing after it changes.

const h = vi.hoisted(() => ({
  made: [] as { network: string; o: Record<string, unknown>; deps: ProbarionDeps }[],
  key: "test-double-nearai-key" as string | null,
  model: null as string | null,
  /** The options each NearApiJsSender was built with, and the calls it was asked to sign. */
  senders: [] as Record<string, unknown>[],
  signed: [] as unknown[],
}));
// The SDK's sender, replaced by one that records how it was built and signs nothing: the real one needs a node.
vi.mock("@probarion/sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@probarion/sdk")>();
  const { TEST_KEYS: keys } = await import("@probarion/sdk/testing");
  class RecordingSender {
    readonly accountId: string;
    readonly publicKey: string;
    constructor(opts: { accountId: string; secretKey: string }) {
      h.senders.push(opts);
      this.accountId = opts.accountId;
      this.publicKey =
        Object.values(keys).find((k) => k.secretKey === opts.secretKey)?.publicKey ?? "unknown";
    }
    async functionCall(tx: unknown) {
      h.signed.push(tx);
      return { txHash: "TX", ok: true };
    }
    async lookup(hash: string) {
      return { txHash: hash, ok: true };
    }
  }
  return { ...sdk, NearApiJsSender: RecordingSender };
});
vi.mock("@/lib/env", async () => {
  const { networkPart } = await import("../../../test/fixtures/networks");
  return {
    getEnv: () => ({
      ...networkPart({ defaultNetwork: "testnet", testnet: { rpcUrls: ["http://127.0.0.1:9"] } }),
      NEARAI_API_KEY: h.key,
      NEARAI_MODEL: h.model,
    }),
  };
});
vi.mock("@/lib/sdk/factory", () => ({
  makeTenantProbarion: (network: string, o: Record<string, unknown>, deps: ProbarionDeps) => {
    h.made.push({ network, o, deps });
    return { process: async () => null, rules: { add: () => {} } };
  },
}));

const { announcing, makePayablesProbarion } = await import("./probarion");

const VAULT = "acme.vaults.probarion.testnet";
const OPTIONS = {
  tenant: { tenant_id: "00000000-0000-4000-8000-000000000001", vault_id: VAULT },
  agentKey: TEST_KEYS.agent.secretKey,
  ledgerKey: TEST_KEYS.ledger.secretKey,
  requestId: "req-1",
};

beforeEach(() => {
  h.made = [];
  h.key = "test-double-nearai-key";
  h.model = null;
  h.senders = [];
  h.signed = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function made(): ProbarionDeps {
  const last = h.made.at(-1);
  if (last === undefined) throw new Error("makeTenantProbarion was not called");
  return last.deps;
}

describe("makePayablesProbarion", () => {
  it("gives makeTenantProbarion its own RPC client, both keys' senders and a NEAR AI proposer", () => {
    makePayablesProbarion("testnet", OPTIONS, payablesBudget(Date.now()));
    expect(h.made).toHaveLength(1);
    expect(h.made[0]?.network).toBe("testnet");
    expect(h.made[0]?.o).toBe(OPTIONS);
    const deps = made();
    expect(deps.rpc).toBeInstanceOf(RpcClient);
    expect(deps.rpc?.currentUrl).toBe("http://127.0.0.1:9");
    expect(deps.agentSender).toMatchObject({
      accountId: VAULT,
      publicKey: TEST_KEYS.agent.publicKey,
    });
    expect(deps.ledgerSender).toMatchObject({
      accountId: VAULT,
      publicKey: TEST_KEYS.ledger.publicKey,
    });
    // the senders keep the lookup that an unknown outcome is resolved with
    expect(typeof deps.agentSender?.lookup).toBe("function");
    expect(deps.proposer).toBeInstanceOf(NearAiProposer);
  });

  it("builds each sender as the SDK builds its own: the vault, the key and the client's URL, and no send timing", () => {
    makePayablesProbarion("testnet", OPTIONS, payablesBudget(Date.now()));
    const rpc = made().rpc as RpcClient;
    expect(h.senders.map((o) => Object.keys(o).sort())).toEqual([
      ["accountId", "rpcUrl", "secretKey"],
      ["accountId", "rpcUrl", "secretKey"],
    ]);
    expect(h.senders.map((o) => o.secretKey)).toEqual([
      TEST_KEYS.agent.secretKey,
      TEST_KEYS.ledger.secretKey,
    ]);
    for (const o of h.senders) {
      expect(o.accountId).toBe(VAULT);
      // no sendTimeoutMs: every step of a send keeps the SDK's default
      expect(o).not.toHaveProperty("sendTimeoutMs");
      expect((o.rpcUrl as () => string)()).toBe(rpc.currentUrl);
    }
  });

  it("makes no proposer without NEARAI_API_KEY, so the cycle decides rules-only as before", () => {
    h.key = null;
    makePayablesProbarion("testnet", OPTIONS, payablesBudget(Date.now()));
    expect(made()).not.toHaveProperty("proposer");
    expect(made().rpc).toBeInstanceOf(RpcClient);
  });

  it("makes no sender for a key it is not given (a read-only instance)", () => {
    makePayablesProbarion(
      "testnet",
      { tenant: OPTIONS.tenant, requestId: "req-2" },
      payablesBudget(Date.now()),
    );
    expect(made()).not.toHaveProperty("agentSender");
    expect(made()).not.toHaveProperty("ledgerSender");
  });

  it("lets a test's deps win over the ones it builds", () => {
    const rpc = new RpcClient({ urls: ["http://127.0.0.1:9"] });
    makePayablesProbarion("testnet", OPTIONS, payablesBudget(Date.now()), {
      deps: { rpc, proposer: null },
    });
    expect(made().rpc).toBe(rpc);
    expect(made().proposer).toBeNull();
  });

  describe("the chain reads", () => {
    const answers = () => {
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        calls.push(String(input instanceof Request ? input.url : input));
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            result: { result: [...new TextEncoder().encode("{}")], logs: [] },
          }),
          { headers: { "content-type": "application/json" } },
        );
      });
      return calls;
    };

    it("run before sendByMs, and are refused after it before any request leaves", async () => {
      const calls = answers();
      let now = 0;
      makePayablesProbarion(
        "testnet",
        OPTIONS,
        payablesBudget(0, () => now),
      );
      const rpc = made().rpc as RpcClient;
      now = 59_000;
      await expect(rpc.viewFunction(VAULT, "get_config")).resolves.toEqual({});
      expect(calls).toHaveLength(1);
      now = 60_000;
      const refused = rpc.viewFunction(VAULT, "get_config");
      await expect(refused).rejects.toBeInstanceOf(RpcError);
      await expect(refused).rejects.toThrow(/the time left for this job ran out/);
      expect(calls).toHaveLength(1);
    });

    it("run with no limit once either key starts a transaction, even past sendByMs", async () => {
      const calls = answers();
      let now = 0;
      const budget = payablesBudget(0, () => now);
      makePayablesProbarion("testnet", OPTIONS, budget);
      const deps = made();
      const rpc = deps.rpc as RpcClient;
      now = 61_000;
      await expect(rpc.viewFunction(VAULT, "get_config")).rejects.toBeInstanceOf(RpcError);
      // The ledger key's anchor (or the agent key's spend) starts: the sender says so before it signs.
      const anchor = { receiverId: VAULT, methodName: "anchor", args: {}, gas: 1n, deposit: 0n };
      await deps.ledgerSender?.functionCall(anchor as never);
      expect(h.signed).toEqual([anchor]);
      expect(budget.chainMs()).toBe(Number.POSITIVE_INFINITY);
      const before = calls.length;
      await expect(rpc.viewFunction(VAULT, "get_config")).resolves.toEqual({});
      expect(calls.length).toBe(before + 1);
    });
  });
});

describe("announcing", () => {
  const outcome = { txHash: "TX", ok: true } as unknown as TxOutcome;

  it("says a transaction starts before the sender signs, then passes it on unchanged", async () => {
    const order: string[] = [];
    const seen: unknown[] = [];
    const inner: TxSender = {
      accountId: VAULT,
      publicKey: TEST_KEYS.agent.publicKey,
      functionCall: async (tx) => {
        order.push("sign and send");
        seen.push(tx);
        return outcome;
      },
      lookup: async function (this: TxSender, hash: string) {
        order.push(`lookup ${hash} as ${this.accountId}`);
        return outcome;
      },
    };
    const wrapped = announcing(inner, () => order.push("sending"));
    expect(wrapped.accountId).toBe(VAULT);
    expect(wrapped.publicKey).toBe(TEST_KEYS.agent.publicKey);
    const tx = { receiverId: VAULT, methodName: "spend", args: { a: 1 }, gas: 1n, deposit: 0n };
    await expect(wrapped.functionCall(tx as never)).resolves.toBe(outcome);
    expect(seen).toEqual([tx]);
    await expect(wrapped.lookup?.("H")).resolves.toBe(outcome);
    expect(order).toEqual(["sending", "sign and send", `lookup H as ${VAULT}`]);
  });

  it("has no lookup when the sender it wraps has none", () => {
    const wrapped = announcing(
      { accountId: VAULT, publicKey: "ed25519:x", functionCall: async () => outcome },
      () => {},
    );
    expect(wrapped).not.toHaveProperty("lookup");
  });

  it("lets a sender's error through as it is", async () => {
    const boom = new Error("node refused");
    const wrapped = announcing(
      {
        accountId: VAULT,
        publicKey: "ed25519:x",
        functionCall: async () => {
          throw boom;
        },
      },
      () => {},
    );
    await expect(wrapped.functionCall({} as never)).rejects.toBe(boom);
  });
});
