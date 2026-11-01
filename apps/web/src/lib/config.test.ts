import { describe, expect, it } from "vitest";
import { appOrigin, explorerAccountUrl, explorerTxUrl } from "./config";

describe("config", () => {
  it("builds explorer links from NETWORKS", () => {
    expect(explorerTxUrl("mainnet", "AbC")).toBe("https://nearblocks.io/txns/AbC");
    expect(explorerTxUrl("testnet", "AbC")).toBe("https://testnet.nearblocks.io/txns/AbC");
    expect(explorerAccountUrl("mainnet", "acme.vaults.probarion.near")).toBe(
      "https://nearblocks.io/address/acme.vaults.probarion.near",
    );
  });

  it("uses the Vercel production domain when present", () => {
    expect(appOrigin({ VERCEL_PROJECT_PRODUCTION_URL: "probarion.xyz" })).toBe(
      "https://probarion.xyz",
    );
    expect(appOrigin({})).toBe("http://localhost:3000");
  });
});
