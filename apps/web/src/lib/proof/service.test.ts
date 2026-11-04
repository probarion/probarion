import { LedgerError } from "@probarion/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, DbError } from "@/lib/db/port";
import { makeSnapshot } from "../../../test/fixtures/snapshot";
import { ProofEvidenceError } from "./evidence";
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

describe("loadProof: why the checks did not run", () => {
  beforeEach(() => {
    clearProofCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const failingWith = (error: unknown) => {
    const { d } = deps(() => 1);
    d.makeReader = () => ({
      snapshot: async () => {
        throw error;
      },
    });
    return d;
  };

  it("says the ledger, not the chain, when the vault's ledger cannot be read from the database", async () => {
    for (const error of [
      new LedgerError("public_ledger returned a page that does not advance"),
      new DbError("db_error", "connection reset"),
    ]) {
      expect(await loadProof(failingWith(error), vault(8))).toMatchObject({
        status: "error",
        reason: "ledger",
      });
    }
  });

  it("says the evidence file when it is malformed, and the chain for anything else", async () => {
    expect(await loadProof(failingWith(new ProofEvidenceError("x")), vault(8))).toMatchObject({
      reason: "evidence",
    });
    expect(await loadProof(failingWith(new Error("RPC down")), vault(8))).toMatchObject({
      reason: "chain",
    });
  });
});

describe("loadProof under concurrent cold requests", () => {
  beforeEach(() => {
    clearProofCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  /** A reader whose gather waits for `open()`, so the test controls when it finishes. */
  function gated(fail = false) {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { d } = deps(() => 1_000_000);
    const makeReader = vi.fn((v: string) => ({
      snapshot: async () => {
        await gate;
        if (fail) throw new Error("RPC down");
        return makeSnapshot({ vault: v, ledger: [], ledgerKey: "ed25519:LK" });
      },
    }));
    d.makeReader = makeReader;
    return { d, makeReader, open: () => open() };
  }

  it("gathers once for many visitors at the same moment, and gives them all the same result", async () => {
    const { d, makeReader, open } = gated();
    const pending = Array.from({ length: 10 }, () => loadProof(d, vault(1)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    open();
    const results = await Promise.all(pending);
    expect(makeReader).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
    expect(results[0]?.status).toBe("ok");
  });

  it("gathers separately for different vaults", async () => {
    const { d, makeReader, open } = gated();
    const pending = [loadProof(d, vault(1)), loadProof(d, vault(2)), loadProof(d, vault(1))];
    await new Promise((resolve) => setTimeout(resolve, 5));
    open();
    await Promise.all(pending);
    expect(makeReader).toHaveBeenCalledTimes(2);
  });

  it("shares a failure with those who waited for it, then lets the next visitor try again", async () => {
    const { d, makeReader, open } = gated(true);
    const pending = Array.from({ length: 3 }, () => loadProof(d, vault(3)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    open();
    for (const r of await Promise.all(pending)) expect(r.status).toBe("error");
    expect(makeReader).toHaveBeenCalledTimes(1);
    expect((await loadProof(d, vault(3))).status).toBe("error");
    expect(makeReader).toHaveBeenCalledTimes(2);
  });
});
