import { describe, expect, it } from "vitest";
import { quietLogs } from "../../../test/fixtures/quiet-logs";
import { type CanaryEnv, canaryView } from "./view";

const logs = quietLogs();

const VAULT = "canary.vaults.probarion.testnet";
/** Each network has its own Canary vault: `vault` is the testnet's, `mainnetVault` the mainnet's. */
const env = (
  over: Partial<Pick<CanaryEnv, "CANARY_MODE">> & {
    vault?: string | null;
    mainnetVault?: string | null;
  } = {},
): CanaryEnv => ({
  CANARY_MODE: over.CANARY_MODE ?? "code-only",
  networks: {
    testnet: { canaryVaultId: over.vault === undefined ? VAULT : over.vault },
    mainnet: { canaryVaultId: over.mainnetVault === undefined ? null : over.mainnetVault },
  },
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
      expect(canaryView(() => env({ CANARY_MODE, vault: null }), "testnet")).toEqual({
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

  it("takes the network it is asked for, and that network's own Canary vault", () => {
    const both = env({ mainnetVault: "canary.vaults.probarion.near" });
    expect(canaryView(() => both, "mainnet")).toEqual({
      kind: "live",
      mode: "code-only",
      vault: "canary.vaults.probarion.near",
      network: "mainnet",
    });
    expect(canaryView(() => both, "testnet")).toMatchObject({ vault: VAULT, network: "testnet" });
  });

  it("is not open yet on a network that has no Canary vault, whatever the other one has", () => {
    // Only testnet has a vault: mainnet is not open yet (the other network's vault is never used for it).
    expect(canaryView(() => env(), "mainnet")).toEqual({
      kind: "replay",
      banner: "closed",
      network: "mainnet",
    });
  });

  it("is a replay that has not opened yet, on the network it is asked for, when the environment cannot be read", () => {
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
