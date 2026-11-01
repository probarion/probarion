import { describe, expect, it } from "vitest";
import {
  EVENT_STANDARD,
  EVENT_VERSION,
  FACTORY_EVENT_STANDARD,
  NEARAI_BASE_URL,
  NETWORKS,
  USDC_DECIMALS,
  WITHDRAW_MEMO_PREFIX,
} from "../src/constants.js";

describe("constants (interfaces §3)", () => {
  it("pins the mainnet ids", () => {
    expect(NETWORKS.mainnet.rpcUrls[0]).toBe("https://rpc.mainnet.fastnear.com");
    expect(NETWORKS.mainnet.usdc).toBe(
      "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    );
    expect(NETWORKS.mainnet.intents).toBe("intents.near");
    expect(NETWORKS.mainnet.allowedAssets.base).toBe(
      "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    );
    expect(NETWORKS.mainnet.allowedAssets.solana).toBe(
      "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    );
    expect(NETWORKS.mainnet.factory).toBe("vaults.probarion.near");
    expect(NETWORKS.mainnet.explorerTx).toBe("https://nearblocks.io/txns/");
  });

  it("pins the testnet ids", () => {
    expect(NETWORKS.testnet.rpcUrls).toEqual(["https://rpc.testnet.fastnear.com"]);
    expect(NETWORKS.testnet.usdc).toBe("usdc.probarion.testnet");
    expect(NETWORKS.testnet.intents).toBe("intents-stub.probarion.testnet");
    expect(NETWORKS.testnet.allowedAssets).toEqual({
      base: "base-usdc.probarion.testnet",
      solana: "sol-usdc.probarion.testnet",
    });
    expect(NETWORKS.testnet.factory).toBe("vaults.probarion.testnet");
    expect(NETWORKS.testnet.explorerTx).toBe("https://testnet.nearblocks.io/txns/");
  });

  it("pins the protocol constants", () => {
    expect(USDC_DECIMALS).toBe(6);
    expect(WITHDRAW_MEMO_PREFIX).toBe("WITHDRAW_TO:");
    expect(EVENT_STANDARD).toBe("probarion");
    expect(FACTORY_EVENT_STANDARD).toBe("probarion_factory");
    expect(EVENT_VERSION).toBe("1.0.0");
    expect(NEARAI_BASE_URL).toBe("https://cloud-api.near.ai/v1");
  });
});
