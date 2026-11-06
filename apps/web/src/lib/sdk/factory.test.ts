import type { ProbarionDeps, ProbarionOptions } from "@probarion/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SupabaseLedgerStore } from "@/lib/ledger/store";

const h = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  made: [] as { opts: ProbarionOptions; deps: ProbarionDeps }[],
  warned: [] as { msg: string; fields: Record<string, unknown> }[],
}));

vi.mock("@probarion/sdk", async (orig) => ({
  ...(await orig<typeof import("@probarion/sdk")>()),
  Probarion: class {
    constructor(opts: ProbarionOptions, deps: ProbarionDeps) {
      h.made.push({ opts, deps });
    }
  },
}));
vi.mock("@/lib/env", () => ({ getEnv: () => h.env }));
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => ({ rpc: async () => null }) }));
vi.mock("@/lib/log", async (orig) => ({
  ...(await orig<typeof import("@/lib/log")>()),
  log: {
    debug: () => {},
    info: () => {},
    error: () => {},
    warn: (msg: string, fields: Record<string, unknown>) => h.warned.push({ msg, fields }),
  },
}));

const { makeTenantProbarion } = await import("./factory");

const TENANT = {
  tenant_id: "00000000-0000-4000-8000-000000000001",
  vault_id: "acme.vaults.probarion.near",
};
const base = {
  networks: {
    mainnet: { rpcUrls: ["https://rpc.example"] },
    testnet: { rpcUrls: ["https://testnet-rpc.example"] },
  },
  NEARAI_API_KEY: null,
  NEARAI_MODEL: null,
};

function made() {
  const m = h.made.at(-1);
  if (!m) throw new Error("no Probarion was made");
  return m;
}

describe("makeTenantProbarion", () => {
  beforeEach(() => {
    h.made.length = 0;
    h.warned.length = 0;
    h.env = { ...base };
  });

  it("builds one tenant's instance on its Supabase ledger, with the request id and both keys", () => {
    makeTenantProbarion("mainnet", {
      tenant: TENANT,
      agentKey: "ed25519:a",
      ledgerKey: "ed25519:l",
      requestId: "req-1",
    });
    const { opts } = made();
    expect(opts).toMatchObject({
      network: "mainnet",
      vault: TENANT.vault_id,
      agentKey: "ed25519:a",
      ledgerKey: "ed25519:l",
      rpcUrls: ["https://rpc.example"],
      requestId: "req-1",
      model: null, // no NEARAI_API_KEY: rules-only
    });
    expect(opts.ledger).toBeInstanceOf(SupabaseLedgerStore);
  });

  it("builds the instance for the network it is given: its chain and its RPC list, not the other's", () => {
    makeTenantProbarion("testnet", { tenant: TENANT, requestId: "r" });
    expect(made().opts).toMatchObject({
      network: "testnet",
      rpcUrls: ["https://testnet-rpc.example"],
    });
    makeTenantProbarion("mainnet", { tenant: TENANT, requestId: "r" });
    expect(made().opts).toMatchObject({ network: "mainnet", rpcUrls: ["https://rpc.example"] });
  });

  it("passes NEAR AI's key and model through, and the persona only when one is given", () => {
    h.env = { ...base, NEARAI_API_KEY: "k-1", NEARAI_MODEL: "model-x" };
    makeTenantProbarion("mainnet", { tenant: TENANT, requestId: "r" });
    expect(made().opts.model).toEqual({
      provider: "near-ai-cloud",
      apiKey: "k-1",
      model: "model-x",
    });
    h.env = { ...base, NEARAI_API_KEY: "k-1" };
    makeTenantProbarion("mainnet", { tenant: TENANT, requestId: "r", systemPrompt: "persona" });
    expect(made().opts.model).toEqual({
      provider: "near-ai-cloud",
      apiKey: "k-1",
      systemPrompt: "persona",
    });
  });

  it("logs the SDK's warnings as this app's log lines, with the request and the tenant", () => {
    makeTenantProbarion("mainnet", { tenant: TENANT, requestId: "req-9" });
    made().deps.logger?.warn("model unavailable; deciding rules-only", { vault: TENANT.vault_id });
    expect(h.warned).toEqual([
      {
        msg: "sdk.warn",
        fields: {
          request_id: "req-9",
          tenant: TENANT.tenant_id,
          message: "model unavailable; deciding rules-only",
          vault: TENANT.vault_id,
        },
      },
    ]);
  });

  it("never lets the SDK's fields replace the request id, the tenant or the message", () => {
    makeTenantProbarion("mainnet", { tenant: TENANT, requestId: "req-10" });
    made().deps.logger?.warn("the real warning", {
      request_id: "forged",
      tenant: "another-tenant",
      message: "forged",
      vault: TENANT.vault_id,
    });
    expect(h.warned.at(-1)?.fields).toEqual({
      request_id: "req-10",
      tenant: TENANT.tenant_id,
      message: "the real warning",
      vault: TENANT.vault_id,
    });
  });
});
