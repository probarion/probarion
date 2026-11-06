import { RpcClient } from "@probarion/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

// Fix round 1, item 3 (adversarial M1): a tenant's Probarion reads no unsuffixed variable from process.env. The SDK falls
// back to NEAR_RPC_URLS and NEAR_ARCHIVAL_RPC_URLS there, whatever the tenant's network; the factory passes `env: {}` and an
// explicit archival client built from the network's own list. The real SDK is built here (no network call: only the
// clients it made are looked at).
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => ({ rpc: async () => null }) }));
vi.mock("@/lib/env", async () => {
  const { networkPart } = await import("../../../test/fixtures/networks");
  return {
    getEnv: () => ({
      ...networkPart({
        defaultNetwork: "testnet",
        both: true,
        mainnet: {
          rpcUrls: ["https://rpc.mainnet.example"],
          archivalRpcUrls: ["https://archival.mainnet.example"],
        },
        testnet: { rpcUrls: ["https://rpc.testnet.example"], archivalRpcUrls: [] },
      }),
      NEARAI_API_KEY: null,
      NEARAI_MODEL: null,
    }),
  };
});

import { makeTenantProbarion } from "./factory";

type Inside = { archivalRpc: RpcClient | null; rpc: RpcClient };
const TENANT = { tenant_id: "t", vault_id: "acme.vaults.probarion.near" };
const saved = { ...process.env };
afterEach(() => {
  process.env.NEAR_ARCHIVAL_RPC_URLS = saved.NEAR_ARCHIVAL_RPC_URLS;
  process.env.NEAR_RPC_URLS = saved.NEAR_RPC_URLS;
  if (saved.NEAR_ARCHIVAL_RPC_URLS === undefined) delete process.env.NEAR_ARCHIVAL_RPC_URLS;
  if (saved.NEAR_RPC_URLS === undefined) delete process.env.NEAR_RPC_URLS;
});

describe("makeTenantProbarion and the process environment", () => {
  it("builds the archival client from the network's own list, not from NEAR_ARCHIVAL_RPC_URLS", () => {
    process.env.NEAR_ARCHIVAL_RPC_URLS = "https://archival-rpc.testnet.fastnear.com";
    process.env.NEAR_RPC_URLS = "https://rpc.testnet.fastnear.com";
    const pb = makeTenantProbarion("mainnet", {
      tenant: TENANT,
      requestId: "r",
    }) as unknown as Inside;
    expect(pb.archivalRpc?.currentUrl).toBe("https://archival.mainnet.example");
    expect(pb.rpc.currentUrl).toBe("https://rpc.mainnet.example");
  });

  it("has no archival client for a network whose list is empty, whatever the environment says", () => {
    process.env.NEAR_ARCHIVAL_RPC_URLS = "https://archival-rpc.mainnet.fastnear.com";
    const pb = makeTenantProbarion("testnet", {
      tenant: TENANT,
      requestId: "r",
    }) as unknown as Inside;
    expect(pb.archivalRpc).toBeNull();
    expect(pb.rpc.currentUrl).toBe("https://rpc.testnet.example");
  });

  it("lets a caller's own deps replace the archival client (tests)", () => {
    const own = new RpcClient({ urls: ["https://own.example"] });
    const pb = makeTenantProbarion(
      "mainnet",
      { tenant: TENANT, requestId: "r" },
      { archivalRpc: own },
    );
    expect((pb as unknown as Inside).archivalRpc).toBe(own);
    const none = makeTenantProbarion(
      "mainnet",
      { tenant: TENANT, requestId: "r" },
      { archivalRpc: null },
    );
    expect((none as unknown as Inside).archivalRpc).toBeNull();
  });
});
