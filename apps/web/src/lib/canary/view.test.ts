import { describe, expect, it } from "vitest";
import { quietLogs } from "../../../test/fixtures/quiet-logs";
import { type CanaryEnv, canaryView } from "./view";

const logs = quietLogs();

const env = (over: Partial<CanaryEnv> = {}): CanaryEnv => ({
  NEAR_NETWORK: "testnet",
  CANARY_MODE: "code-only",
  CANARY_VAULT_ID: "canary.vaults.probarion.testnet",
  ...over,
});

describe("canaryView", () => {
  it("shows the live page for live and code-only when a vault is set", () => {
    expect(canaryView(() => env({ CANARY_MODE: "live" }), "testnet")).toEqual({
      kind: "live",
      mode: "live",
      vault: "canary.vaults.probarion.testnet",
      network: "testnet",
    });
    expect(canaryView(() => env(), "testnet")).toMatchObject({ kind: "live", mode: "code-only" });
  });

  it("says the Canary is paused in off mode, and a replay in replay mode", () => {
    expect(canaryView(() => env({ CANARY_MODE: "off" }), "testnet")).toEqual({
      kind: "replay",
      banner: "off",
      network: "testnet",
    });
    expect(canaryView(() => env({ CANARY_MODE: "replay" }), "testnet")).toEqual({
      kind: "replay",
      banner: "replay",
      network: "testnet",
    });
  });

  it("is a replay that has not opened yet when no vault is set, in either live mode", () => {
    for (const CANARY_MODE of ["live", "code-only"] as const) {
      expect(canaryView(() => env({ CANARY_MODE, CANARY_VAULT_ID: null }), "testnet")).toEqual({
        kind: "replay",
        banner: "closed",
        network: "testnet",
      });
    }
  });

  it("does not show the live page in replay or off mode even when a vault is set", () => {
    for (const CANARY_MODE of ["replay", "off"] as const) {
      expect(canaryView(() => env({ CANARY_MODE }), "testnet").kind).toBe("replay");
    }
  });

  it("takes the network from the environment", () => {
    expect(canaryView(() => env({ NEAR_NETWORK: "mainnet" }), "testnet")).toMatchObject({
      network: "mainnet",
    });
  });

  it("is a replay that has not opened yet, on the build's network, when the environment cannot be read", () => {
    const broken = () => {
      throw new Error("Invalid environment: KEY_ENCRYPTION_SECRET is required");
    };
    expect(canaryView(broken, "mainnet")).toEqual({
      kind: "replay",
      banner: "closed",
      network: "mainnet",
    });
    expect(logs.lines.filter((l) => l.includes("canary.page_env_unavailable"))).toHaveLength(1);
  });
});
