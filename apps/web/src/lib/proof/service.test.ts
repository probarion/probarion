import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/port";
import { makeSnapshot } from "../../../test/fixtures/snapshot";
import { clearProofCache, loadProof, type ProofDeps } from "./service";

// The cache and the log, with fake databases: any vault id is a public mainnet vault with an empty ledger.
const anyPublic: Db = {
  rpc: async <T>(fn: string, p: Record<string, unknown> = {}) =>
    (fn === "public_vault"
      ? { vault_id: p.vault_id, network: "mainnet", kind: "team", display_name: "x" }
      : []) as T,
};
const unused: Db = {
  rpc: async () => {
    throw new Error("unused");
  },
};

function deps(now: () => number) {
  const makeReader = vi.fn((vault: string) => ({
    snapshot: async () => makeSnapshot({ vault, ledger: [], ledgerKey: "ed25519:LK" }),
  }));
  const d: ProofDeps = {
    network: "mainnet",
    publicDb: anyPublic,
    serviceDb: unused,
    sessionAccount: null,
    makeReader,
    now,
  };
  return { d, makeReader };
}

const vault = (i: number) => `v${i}.vaults.probarion.near`;

describe("loadProof's cache stays bounded", () => {
  beforeEach(() => clearProofCache());

  it("holds 500 results; the 501st, with none expired, starts it over", async () => {
    const { d, makeReader } = deps(() => 1_000_000);
    for (let i = 1; i <= 500; i++) await loadProof(d, vault(i));
    expect(makeReader).toHaveBeenCalledTimes(500);
    // All 500 are still served from the cache.
    await loadProof(d, vault(1));
    await loadProof(d, vault(500));
    expect(makeReader).toHaveBeenCalledTimes(500);
    // A 501st vault: nothing has expired, so the cache is cleared before it is stored.
    await loadProof(d, vault(501));
    await loadProof(d, vault(501));
    expect(makeReader).toHaveBeenCalledTimes(501);
    await loadProof(d, vault(2));
    expect(makeReader).toHaveBeenCalledTimes(502);
  });

  it("drops what has expired (60 s old or more) first, and keeps the rest", async () => {
    let t = 1_000_000;
    const { d, makeReader } = deps(() => t);
    await loadProof(d, vault(1));
    t += 60_000;
    for (let i = 2; i <= 500; i++) await loadProof(d, vault(i));
    // The cache is full; vault 1 is exactly 60 s old, so storing a new vault drops it and nothing else.
    await loadProof(d, vault(501));
    expect(makeReader).toHaveBeenCalledTimes(501);
    await loadProof(d, vault(2));
    await loadProof(d, vault(501));
    expect(makeReader).toHaveBeenCalledTimes(501);
  });
});

describe("loadProof's log", () => {
  let lines: string[];
  beforeEach(() => {
    clearProofCache();
    lines = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("says why the checks did not run, for which vault, without failing the page", async () => {
    const { d } = deps(() => 1);
    d.makeReader = () => ({
      snapshot: async () => {
        throw new Error("all 2 RPC endpoint(s) failed");
      },
    });
    expect((await loadProof(d, vault(7))).status).toBe("error");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "warn",
      msg: "proof.unavailable",
      vault: vault(7),
      reason: "chain",
      error: "all 2 RPC endpoint(s) failed",
    });
  });
});
