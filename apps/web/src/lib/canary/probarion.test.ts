import type { MandateView } from "@probarion/core";
import { NearAiProposer } from "@probarion/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DecryptError } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { KeyMismatchError } from "@/lib/keys/service";
import { quietLogs } from "../../../test/fixtures/quiet-logs";
import { CANARY_SYSTEM_PROMPT } from "./prompt";
import { CANARY_NO_AUTOPAY_ID, canaryNoAutopay } from "./rules";

const h = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  ledger: null as unknown,
  agent: null as unknown,
  agentFor: [] as string[],
  made: [] as { opts: Record<string, unknown>; deps: Record<string, unknown> }[],
  rules: [] as unknown[],
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
  makeTenantProbarion: (opts: Record<string, unknown>, deps: Record<string, unknown> = {}) => {
    h.made.push({ opts, deps });
    return { rules: { add: (rule: unknown) => h.rules.push(rule) } };
  },
}));

const { CANARY_NEARAI_TIMEOUTS_MS, makeCanaryProbarion } = await import("./probarion");

const logs = quietLogs();
const db = {} as Db;
const MASTER = new Uint8Array(32).fill(7);
const tenant = { tenant_id: "t-1", vault_id: "canary.vaults.probarion.near" };
const mandate = { id: 3, agent_pk: "ed25519:agentpk" } as MandateView;
const ledgerKey = { publicKey: "ed25519:ledgerpk", secret: "ed25519:ledgersecret" };
const agentKey = { publicKey: "ed25519:agentpk", secret: "ed25519:agentsecret" };

beforeEach(() => {
  h.env = { NEARAI_API_KEY: "test-key", NEARAI_MODEL: null };
  h.ledger = ledgerKey;
  h.agent = agentKey;
  h.agentFor = [];
  h.made = [];
  h.rules = [];
});

describe("makeCanaryProbarion", () => {
  it("signs with the mandate's own agent key and the ledger key, with the Canary persona", async () => {
    const pb = await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-1");
    expect(pb).not.toBeNull();
    expect(h.agentFor).toEqual(["ed25519:agentpk"]);
    expect(h.made).toHaveLength(1);
    expect(h.made[0]?.opts).toEqual({
      tenant,
      agentKey: "ed25519:agentsecret",
      ledgerKey: "ed25519:ledgersecret",
      requestId: "req-1",
      systemPrompt: CANARY_SYSTEM_PROMPT,
    });
  });

  it("adds the rule that the Canary never pays from its own cycle", async () => {
    await makeCanaryProbarion(db, MASTER, tenant, mandate, "req-1");
    expect(h.rules).toEqual([canaryNoAutopay]);
    expect(canaryNoAutopay.id).toBe(CANARY_NO_AUTOPAY_ID);
  });

  it("gives the SDK a NEAR AI proposer with the Canary's own timeouts, so a cycle ends well inside 60 s", async () => {
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
    // the model's work, with its retries, stays far under the route's 60 s
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
