import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NETWORKS } from "../src/index.js";

// The deployment records are the source of truth for what is actually on chain. `src/` must stay
// free of filesystem access, so the cross-check lives in this test only.
function readDeployment(name: "testnet" | "mainnet"): Record<string, unknown> {
  const url = new URL(`../../../contracts/deployments/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

interface TestnetRecord {
  network: string;
  accounts: {
    usdc: string;
    base_asset: string;
    solana_asset: string;
    intents_stub: string;
    factory: string;
  };
}

interface MainnetRecord {
  network: string;
  constants: { usdc: string; intents: string; allowed_assets: string[] };
  factory: { account_id: string };
}

describe("NETWORKS matches the deployment records", () => {
  it("testnet: usdc, intents stub, allowed assets and factory", () => {
    const record = readDeployment("testnet") as unknown as TestnetRecord;
    expect(record.network).toBe("testnet");
    expect(NETWORKS.testnet.usdc).toBe(record.accounts.usdc);
    expect(NETWORKS.testnet.intents).toBe(record.accounts.intents_stub);
    expect(NETWORKS.testnet.allowedAssets.base).toBe(record.accounts.base_asset);
    expect(NETWORKS.testnet.allowedAssets.solana).toBe(record.accounts.solana_asset);
    expect([NETWORKS.testnet.allowedAssets.base, NETWORKS.testnet.allowedAssets.solana]).toEqual([
      record.accounts.base_asset,
      record.accounts.solana_asset,
    ]);
    expect(NETWORKS.testnet.factory).toBe(record.accounts.factory);
  });

  it("mainnet: usdc, intents, allowed assets and factory", () => {
    const record = readDeployment("mainnet") as unknown as MainnetRecord;
    expect(record.network).toBe("mainnet");
    expect(NETWORKS.mainnet.usdc).toBe(record.constants.usdc);
    expect(NETWORKS.mainnet.intents).toBe(record.constants.intents);
    expect([NETWORKS.mainnet.allowedAssets.base, NETWORKS.mainnet.allowedAssets.solana]).toEqual(
      record.constants.allowed_assets,
    );
    expect(NETWORKS.mainnet.factory).toBe(record.factory.account_id);
  });

  it("pins the mainnet RPC list in full", () => {
    expect(NETWORKS.mainnet.rpcUrls).toEqual([
      "https://rpc.mainnet.fastnear.com",
      "https://rpc.intea.rs",
    ]);
  });
});
