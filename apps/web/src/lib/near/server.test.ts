import { NETWORKS } from "@probarion/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 32 distinct bytes: a key that is one repeated byte is rejected.
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256)).toString("base64");
const BASE_ENV = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x",
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_x",
  KEY_ENCRYPTION_SECRET: KEY,
  CRON_SECRET: "c".repeat(40),
};

/**
 * A fresh copy of the module (and of getEnv's cache) under the given environment. The SDK is
 * re-imported too: resetModules gives the fresh server its own copy of every class.
 */
async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [name, value] of Object.entries({ ...BASE_ENV, ...env })) vi.stubEnv(name, value);
  const [server, sdk] = await Promise.all([import("./server"), import("@probarion/sdk")]);
  return { ...server, RpcClient: sdk.RpcClient };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("near/server", () => {
  it("builds the SDK RpcClient from NEAR_RPC_URLS, in failover order", async () => {
    const { getRpc, RpcClient } = await load({
      NEAR_NETWORK: "mainnet",
      NEAR_RPC_URLS: "https://a.example, https://b.example",
    });
    const rpc = getRpc();
    expect(rpc).toBeInstanceOf(RpcClient);
    expect(rpc.currentUrl).toBe("https://a.example");
  });

  it("falls back to the network's providers when NEAR_RPC_URLS is empty (R12)", async () => {
    const { getRpc } = await load({ NEAR_NETWORK: "testnet", NEAR_RPC_URLS: "  " });
    expect(getRpc().currentUrl).toBe(NETWORKS.testnet.rpcUrls[0]);
  });

  it("gives up after two rounds over the providers, as a transport error", async () => {
    const { getReader } = await load({
      NEAR_NETWORK: "mainnet",
      NEAR_RPC_URLS: "https://only.example",
    });
    const down = vi.fn(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", down);
    try {
      const error = await getReader()
        .getConfig("v.near")
        .catch((e: unknown) => e);
      const { chainErrorKind } = await import("./reader");
      expect(chainErrorKind(error)).toBe("transport");
      expect(down).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shares one client and one reader per process", async () => {
    const { getRpc, getReader } = await load({ NEAR_NETWORK: "testnet" });
    expect(getRpc()).toBe(getRpc());
    expect(getReader()).toBe(getReader());
    expect(typeof getReader().getConfig).toBe("function");
  });

  it("returns the fixed addresses of NEAR_NETWORK", async () => {
    const mainnet = await load({ NEAR_NETWORK: "mainnet" });
    expect(mainnet.chainConsts()).toStrictEqual(NETWORKS.mainnet);
    expect(mainnet.chainConsts().intents).toBe("intents.near");
    const testnet = await load({ NEAR_NETWORK: "testnet" });
    expect(testnet.chainConsts()).toStrictEqual(NETWORKS.testnet);
  });

  it("does not call getEnv on import, only when a function is used", async () => {
    vi.resetModules();
    const getEnv = vi.fn(() => ({
      NEAR_NETWORK: "testnet",
      NEAR_RPC_URLS: ["https://a.example"],
    }));
    vi.doMock("@/lib/env", () => ({ getEnv }));
    try {
      const server = await import("./server");
      expect(getEnv).not.toHaveBeenCalled();
      server.chainConsts();
      expect(getEnv).toHaveBeenCalledTimes(1);
      server.getRpc();
      expect(getEnv).toHaveBeenCalledTimes(2);
      // The client is cached: a second read of the environment is not needed.
      server.getRpc();
      expect(getEnv).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("@/lib/env");
      vi.resetModules();
    }
  });

  it("imports with an invalid environment and fails only when a function is used", async () => {
    // Nothing valid is set: importing must not throw, so `next build` needs no runtime secrets.
    vi.resetModules();
    vi.stubEnv("KEY_ENCRYPTION_SECRET", "not-a-key");
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NEAR_NETWORK", "no-such-network");
    const server = await import("./server");
    expect(() => server.getRpc()).toThrow(/Invalid environment/);
    expect(() => server.chainConsts()).toThrow(/Invalid environment/);
  });
});
