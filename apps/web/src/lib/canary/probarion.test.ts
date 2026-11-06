import { generateKeyPair, type MandateView } from "@probarion/core";
import { NearAiProposer, NearApiJsSender, RpcClient, RpcError } from "@probarion/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecryptError } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { KeyMismatchError } from "@/lib/keys/service";
import { quietLogs } from "../../../test/fixtures/quiet-logs";
import { CANARY_LIMITS } from "./limits";
import { CANARY_SYSTEM_PROMPT } from "./prompt";
import { CANARY_NO_AUTOPAY_ID, canaryNoAutopay } from "./rules";

const h = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  ledger: null as unknown,
  agent: null as unknown,
  agentFor: [] as string[],
  made: [] as { network: string; opts: Record<string, unknown>; deps: Record<string, unknown> }[],
  rules: [] as unknown[],
  processThrows: false,
}));

vi.mock("@/lib/env", () => ({ getEnv: () => h.env }));
vi.mock("@/lib/keys/service", async (original) => ({
  ...(await original<typeof import("@/lib/keys/service")>()),
  loadActiveSecret: async () => {
    if (h.ledger instanceof Error) throw h.ledger;
    return h.ledger;
  },
  loadActiveSecretFor: async (_db: unknown, _master: unknown, _tenant: string, pk: string) => {
    h.agentFor.push(pk);
    if (h.agent instanceof Error) throw h.agent;
    return h.agent;
  },
}));
vi.mock("@/lib/sdk/factory", () => ({
  makeTenantProbarion: (
    network: string,
    opts: Record<string, unknown>,
    deps: Record<string, unknown> = {},
  ) => {
    h.made.push({ network, opts, deps });
    return {
      rules: { add: (rule: unknown) => h.rules.push(rule) },
      process: async () => {
        if (h.processThrows) throw new Error("the cycle failed");
        return { status: "refused_by_code" };
      },
      checkSpend: async () => ({ ok: false, code: "NoMandate", would_hold: false }),
      requestSpend: async () => ({ status: "refused_by_contract" }),
    };
  },
}));

const { CANARY_NEARAI_TIMEOUTS_MS, makeCanaryProbarion, resetCanaryModelCache } = await import(
  "./probarion"
);

const logs = quietLogs();
const db = {} as Db;
const MASTER = new Uint8Array(32).fill(7);
const tenant = {
  tenant_id: "t-1",
  vault_id: "canary.vaults.probarion.near",
  network: "mainnet" as const,
};
const mandate = { id: 3, agent_pk: "ed25519:agentpk" } as MandateView;
// Throwaway keys for tests only, derived from fixed seeds. They hold nothing anywhere.
const agentPair = generateKeyPair(Uint8Array.from({ length: 32 }, (_, i) => i + 11));
const ledgerPair = generateKeyPair(Uint8Array.from({ length: 32 }, (_, i) => i + 111));
const ledgerKey = { publicKey: ledgerPair.publicKey, secret: ledgerPair.secretKey };
const agentKey = { publicKey: agentPair.publicKey, secret: agentPair.secretKey };
const cycle = { text: "t", facts: {} as never, ref: "r" };
/** The i-th SDK instance the code under test made. */
const made = (i: number) => {
  const m = h.made[i];
  if (m === undefined) throw new Error(`no instance ${i} was made`);
  return m;
};

beforeEach(() => {
  h.env = {
    NEARAI_API_KEY: "test-key",
    NEARAI_MODEL: null,
    networks: {
      mainnet: { rpcUrls: ["https://rpc.test/key-in-path"] },
      testnet: { rpcUrls: ["https://testnet-rpc.test/other"] },
    },
  };
  h.ledger = ledgerKey;
  h.agent = agentKey;
  h.agentFor = [];
  h.made = [];
  h.rules = [];
  h.processThrows = false;
  resetCanaryModelCache();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("makeCanaryProbarion", () => {
  it("signs with the mandate's own agent key and the ledger key, with the Canary persona", async () => {
    const pb = await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-1");
    expect(pb).not.toBeNull();
    expect(h.agentFor).toEqual(["ed25519:agentpk"]);
    expect(h.made).toHaveLength(1);
    // The instance is made for the tenant's own network.
    expect(h.made[0]?.network).toBe("mainnet");
    expect(h.made[0]?.opts).toEqual({
      tenant,
      agentKey: agentPair.secretKey,
      ledgerKey: ledgerPair.secretKey,
      requestId: "req-1",
      systemPrompt: CANARY_SYSTEM_PROMPT,
    });
  });

  it("adds the rule that the Canary never pays from its own cycle", async () => {
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-1");
    expect(h.rules).toEqual([canaryNoAutopay]);
    expect(canaryNoAutopay.id).toBe(CANARY_NO_AUTOPAY_ID);
  });

  it("gives the SDK a NEAR AI proposer with the Canary's own timeouts", async () => {
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-1");
    const proposer = h.made[0]?.deps.proposer;
    expect(proposer).toBeInstanceOf(NearAiProposer);
    expect((proposer as unknown as { timeouts: unknown }).timeouts).toEqual(
      CANARY_NEARAI_TIMEOUTS_MS,
    );
    expect(CANARY_NEARAI_TIMEOUTS_MS).toEqual({
      catalog: 6000,
      report: 6000,
      chat: 30_000,
      signature: 6000,
    });
    // each phase's own cap: the attempt's deadline (below) is what bounds their sum
    const { chat, ...others } = CANARY_NEARAI_TIMEOUTS_MS;
    for (const ms of Object.values(others)) expect(ms).toBeLessThanOrEqual(6000);
    expect(chat).toBeLessThanOrEqual(30_000);
  });

  it("uses the configured model and the Canary persona for the proposer", async () => {
    h.env.NEARAI_MODEL = "some/model";
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-1");
    const proposer = h.made[0]?.deps.proposer as unknown as {
      opts: { model?: string; systemPrompt?: string; apiKey: string };
    };
    expect(proposer.opts).toMatchObject({
      model: "some/model",
      systemPrompt: CANARY_SYSTEM_PROMPT,
      apiKey: "test-key",
    });
  });

  it("lets a caller's own deps (tests) replace the proposer and add the rest", async () => {
    const own = { name: "own" };
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-1", {
      proposer: own as never,
      archivalRpc: null,
    });
    expect(h.made[0]?.deps).toEqual({ proposer: own, archivalRpc: null });
  });

  it("is null, and builds nothing, without a NEAR AI key: a Canary with no model has nothing to fool", async () => {
    h.env.NEARAI_API_KEY = null;
    expect(await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-1")).toBeNull();
    expect(h.made).toEqual([]);
  });

  it.each([
    ["no active ledger key", { ledger: null }],
    ["no active key for the mandate", { agent: null }],
    ["a ledger key that cannot be opened", { ledger: new DecryptError() }],
    ["a mandate key that does not match its public key", { agent: new KeyMismatchError() }],
  ])("is null, and logs which key and why, for %s", async (_name, over) => {
    Object.assign(h, over);
    expect(await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-1")).toBeNull();
    expect(h.made).toEqual([]);
    const line = logs.lines.find((l) => l.includes("canary.key_unavailable"));
    expect(line).toContain('"mandate_id":3');
    expect(line).not.toContain("secret");
  });
});

// One deadline for the whole attempt (ruling W-T17-R2): every phase gets the smaller of its own cap and the time left.
describe("makeCanaryProbarion with the attempt's time", () => {
  let left = 50_000;
  const budget = { remainingMs: () => left };
  beforeEach(() => {
    left = 50_000;
  });
  const build = () => makeCanaryProbarion(db, MASTER, tenant, mandate, "req-1", {}, budget);

  it("changes nothing for a caller that gives no time (no client, no sender of its own)", async () => {
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-1");
    expect(h.made[0]?.deps.rpc).toBeUndefined();
    expect(h.made[0]?.deps.agentSender).toBeUndefined();
    expect(h.made[0]?.deps.ledgerSender).toBeUndefined();
  });

  it("gives the SDK a chain client that stops when the time is over, and one sender per key", async () => {
    await build();
    const { rpc, agentSender, ledgerSender } = made(0).deps as {
      rpc: RpcClient;
      agentSender: NearApiJsSender;
      ledgerSender: NearApiJsSender;
    };
    expect(rpc).toBeInstanceOf(RpcClient);
    expect(agentSender).toBeInstanceOf(NearApiJsSender);
    expect(ledgerSender).toBeInstanceOf(NearApiJsSender);
    // each signs with its own key, on the vault
    expect(agentSender.publicKey).toBe(agentPair.publicKey);
    expect(ledgerSender.publicKey).toBe(ledgerPair.publicKey);
    expect(agentSender.accountId).toBe(tenant.vault_id);
    expect(ledgerSender.accountId).toBe(tenant.vault_id);
    // with no time left the client makes no request at all
    left = 0;
    const error = (await rpc.viewAccount("a.testnet").catch((e: unknown) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error.message).toMatch(/time left/);
  });

  it("gives the proposer no more than the model budget or the time left, counted from its first call", async () => {
    expect(CANARY_LIMITS.chainStepTimeoutMs).toBe(8000);
    expect(CANARY_LIMITS.modelBudgetMs).toBe(30_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    await build();
    const proposer = h.made[0]?.deps.proposer as unknown as { opts: { remainingMs: () => number } };
    const remaining = proposer.opts.remainingMs;
    // ALL model calls of one attempt share 30 s, counted from the first call
    expect(remaining()).toBe(30_000);
    vi.advanceTimersByTime(12_000);
    left -= 12_000;
    expect(remaining()).toBe(18_000);
    // and never more than the attempt has left
    left = 5000;
    expect(remaining()).toBe(5000);
    left = 0;
    expect(remaining()).toBeLessThanOrEqual(0);
  });

  it("keeps the NEAR AI caps next to the shared budget", async () => {
    await build();
    const proposer = h.made[0]?.deps.proposer as unknown as { timeouts: unknown };
    expect(proposer.timeouts).toEqual(CANARY_NEARAI_TIMEOUTS_MS);
  });
});

// The catalog and the probe that picks the model are the same for every attempt: they are kept for a while per warm
// process. The attestation report is not (its nonce is the point), and it is still fetched for every attempt.
describe("makeCanaryProbarion keeps the resolved model", () => {
  /** Builds one, lets the (fake) proposer resolve `resolved` while the cycle runs, and runs the cycle. */
  const runOnce = async (resolved: string | null) => {
    const pb = await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-1");
    const proposer = h.made.at(-1)?.deps.proposer as unknown as { resolved: string | null };
    proposer.resolved = resolved;
    await pb?.process(cycle).catch(() => undefined);
  };
  const known = (i: number) =>
    (made(i).deps.proposer as unknown as { opts: { knownModel?: string } }).opts.knownModel;

  it("passes a model resolved by an earlier attempt to the next one, so it skips the catalog and the probe", async () => {
    expect(CANARY_LIMITS.modelCacheMs).toBe(600_000);
    await runOnce("some/model");
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-2");
    expect(known(0)).toBeUndefined();
    expect(known(1)).toBe("some/model");
    expect((made(1).deps.proposer as NearAiProposer).resolvedModel).toBe("some/model");
  });

  it("forgets it after ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await runOnce("some/model");
    vi.advanceTimersByTime(CANARY_LIMITS.modelCacheMs - 1000);
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-2");
    expect(known(1)).toBe("some/model");
    vi.advanceTimersByTime(2000);
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-3");
    expect(known(2)).toBeUndefined();
  });

  // The ten minutes run from when the model was RESOLVED, never from its last use: under steady traffic a cache that slid
  // would never re-run the catalog and the probe, and a model that stopped returning NEAR attestation would stay chosen.
  it("never renews it by using it: the ten minutes run from when the model was resolved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const minute = 60_000;
    await runOnce("some/model"); // minute 0: this proposer resolved it itself
    // cycles that use the cached model, at minutes 0, 4 and 9, renew nothing
    let at = 0;
    for (const [i, minutes] of [
      [1, 0],
      [2, 4],
      [3, 9],
    ] as const) {
      vi.advanceTimersByTime((minutes - at) * minute);
      at = minutes;
      await runOnce("some/model");
      expect(known(i)).toBe("some/model");
    }
    // at minute 10 the model is not kept any more: the catalog and the probe run again
    vi.advanceTimersByTime((10 - at) * minute);
    await runOnce("other/model");
    expect(known(4)).toBeUndefined();
    // and what that proposer resolved is kept from then on, for its own ten minutes
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-after");
    expect(known(5)).toBe("other/model");
    vi.advanceTimersByTime(9 * minute);
    await runOnce("other/model");
    expect(known(6)).toBe("other/model");
    vi.advanceTimersByTime(minute);
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-late");
    expect(known(7)).toBeUndefined();
  });

  it("keeps nothing when the attempt resolved no model", async () => {
    await runOnce(null);
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-2");
    expect(known(1)).toBeUndefined();
  });

  it("keeps it when the cycle throws after the model was resolved", async () => {
    h.processThrows = true;
    await runOnce("some/model");
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-2");
    expect(known(1)).toBe("some/model");
  });

  it("never uses it for a caller's own proposer, and never remembers one", async () => {
    await runOnce("some/model");
    const own = { name: "own", resolvedModel: "other/model", resolved: "other/model" };
    const pb = await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-2", {
      proposer: own as never,
    });
    expect(h.made[1]?.deps.proposer).toBe(own);
    await pb?.process(cycle);
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-3");
    expect(known(2)).toBe("some/model");
  });
});
