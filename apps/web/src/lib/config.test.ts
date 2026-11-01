import type { NetworkId } from "@probarion/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { appOrigin, explorerAccountUrl, explorerTxUrl, type Network } from "./config";

describe("config", () => {
  it("builds explorer links from NETWORKS", () => {
    expect(explorerTxUrl("mainnet", "AbC")).toBe("https://nearblocks.io/txns/AbC");
    expect(explorerTxUrl("testnet", "AbC")).toBe("https://testnet.nearblocks.io/txns/AbC");
    expect(explorerAccountUrl("mainnet", "acme.vaults.probarion.near")).toBe(
      "https://nearblocks.io/address/acme.vaults.probarion.near",
    );
    expect(explorerAccountUrl("testnet", "acme.vaults.probarion.testnet")).toBe(
      "https://testnet.nearblocks.io/address/acme.vaults.probarion.testnet",
    );
  });

  it("URL-encodes the hash and the account, so they cannot change the link", () => {
    expect(explorerTxUrl("mainnet", "a/b?c=d#e")).toBe(
      "https://nearblocks.io/txns/a%2Fb%3Fc%3Dd%23e",
    );
    expect(explorerTxUrl("mainnet", "../../evil")).toBe(
      "https://nearblocks.io/txns/..%2F..%2Fevil",
    );
    expect(explorerAccountUrl("mainnet", "x/../y?z")).toBe(
      "https://nearblocks.io/address/x%2F..%2Fy%3Fz",
    );
    // A NEAR transaction hash (base58) and an implicit account (64 hex) pass through unchanged.
    const hash = "5ZKq3dRrSTLsmDrbS1mfXx6Uvg9YoMXZWkLhVfGTsdsm";
    const implicit = "a".repeat(64);
    expect(explorerTxUrl("mainnet", hash)).toBe(`https://nearblocks.io/txns/${hash}`);
    expect(explorerAccountUrl("mainnet", implicit)).toBe(
      `https://nearblocks.io/address/${implicit}`,
    );
  });

  it("takes its Network type from core, so the two cannot drift", () => {
    expectTypeOf<Network>().toEqualTypeOf<NetworkId>();
  });

  it("uses the Vercel production domain when present", () => {
    expect(appOrigin({ VERCEL_PROJECT_PRODUCTION_URL: "probarion.xyz" })).toBe(
      "https://probarion.xyz",
    );
    expect(appOrigin({})).toBe("http://localhost:3000");
  });

  it("treats an empty or whitespace-only domain as unset (R12)", () => {
    expect(appOrigin({ VERCEL_PROJECT_PRODUCTION_URL: "" })).toBe("http://localhost:3000");
    expect(appOrigin({ VERCEL_PROJECT_PRODUCTION_URL: "  " })).toBe("http://localhost:3000");
    expect(appOrigin({ VERCEL_PROJECT_PRODUCTION_URL: " probarion.xyz " })).toBe(
      "https://probarion.xyz",
    );
  });
});
