import { LedgerError } from "@probarion/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, DbError } from "@/lib/db/port";
import { makeSnapshot } from "../../../test/fixtures/snapshot";
import { ProofEvidenceError } from "./evidence";
import { clearProofCache, loadLedger, loadProof, type ProofDeps } from "./service";

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

  it("stops sharing a gather that is stuck for 30 s: the next visitor starts a new one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { d, makeReader } = gated(); // never opened: the first gather is stuck
      void loadProof(d, vault(4));
      await vi.advanceTimersByTimeAsync(29_999);
      void loadProof(d, vault(4));
      await vi.advanceTimersByTimeAsync(0);
      expect(makeReader).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      void loadProof(d, vault(4));
      await vi.advanceTimersByTimeAsync(0);
      expect(makeReader).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

describe("loadProof: how old a cached result can be", () => {
  beforeEach(() => {
    clearProofCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("counts a cached result's 60 s from the start of its gather, not its end", async () => {
    let t = 1_000_000;
    let open: () => void = () => {};
    const { d } = deps(() => t);
    const makeReader = vi.fn((v: string) => ({
      snapshot: async () => {
        if (makeReader.mock.calls.length === 1) {
          await new Promise<void>((resolve) => {
            open = resolve;
          });
        }
        return makeSnapshot({ vault: v, ledger: [], ledgerKey: "ed25519:LK" });
      },
    }));
    d.makeReader = makeReader;
    const first = loadProof(d, vault(5)); // starts at t0
    await new Promise((resolve) => setTimeout(resolve, 5));
    t += 10_000; // the gather takes 10 s
    open();
    await first;
    t = 1_000_000 + 59_999;
    await loadProof(d, vault(5));
    expect(makeReader).toHaveBeenCalledTimes(1);
    t = 1_000_000 + 60_000; // 60 s after the start, though only 50 s after the end
    await loadProof(d, vault(5));
    expect(makeReader).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer cached result when a late, older gather lands after the 30 s limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let t = Date.parse("2026-11-08T12:00:00.000Z");
    let openA: () => void = () => {};
    const { d } = deps(() => t);
    const makeReader = vi.fn((v: string) => {
      const n = makeReader.mock.calls.length;
      return {
        snapshot: async () => {
          const takenAt = new Date(t).toISOString(); // stamped at the start, as the SDK does
          if (n === 1) {
            await new Promise<void>((resolve) => {
              openA = resolve;
            });
          }
          return {
            ...makeSnapshot({ vault: v, ledger: [], ledgerKey: "ed25519:LK" }),
            taken_at: takenAt,
          };
        },
      };
    });
    d.makeReader = makeReader;
    const a = loadProof(d, vault(6)); // gather A: stuck
    await vi.advanceTimersByTimeAsync(30_000); // its sharing ends
    t += 31_000;
    const b = await loadProof(d, vault(6)); // gather B lands and is cached
    expect(makeReader).toHaveBeenCalledTimes(2);
    t += 14_000;
    openA();
    const late = await a;
    expect(late.status === "ok" && late.snapshot.taken_at).toBe("2026-11-08T12:00:00.000Z");
    const next = await loadProof(d, vault(6));
    expect(makeReader).toHaveBeenCalledTimes(2);
    expect(next).toBe(b);
    expect(next.status === "ok" && next.snapshot.taken_at).toBe("2026-11-08T12:00:31.000Z");
  });
});

describe("loadLedger (ledger.jsonl)", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  const ledgerDeps = (publicDb: Db, network: "mainnet" | "testnet" = "mainnet") => ({
    network,
    publicDb,
    serviceDb: unused,
    sessionAccount: null,
  });

  it("serves a public vault's ledger with the page's access rules", async () => {
    expect(await loadLedger(ledgerDeps(anyPublic), vault(1))).toEqual({
      status: "ok",
      vault: vault(1),
      network: "mainnet",
      audience: "public",
      entries: [],
    });
  });

  it("answers not_found for an invalid id (asking nothing), a hidden vault, and the other network", async () => {
    const calls: string[] = [];
    const counted: Db = {
      rpc: async <T>(fn: string, p?: Record<string, unknown>) => {
        calls.push(fn);
        return anyPublic.rpc<T>(fn, p);
      },
    };
    expect(await loadLedger(ledgerDeps(counted), "../etc")).toEqual({ status: "not_found" });
    expect(calls).toEqual([]);
    const hidden: Db = { rpc: async <T>() => null as T };
    expect(await loadLedger(ledgerDeps(hidden), vault(1))).toEqual({ status: "not_found" });
    expect(await loadLedger(ledgerDeps(anyPublic, "testnet"), vault(1))).toEqual({
      status: "not_found",
    });
  });

  it("says the ledger could not be read when the database answers badly", async () => {
    const broken: Db = {
      rpc: async <T>(fn: string, p?: Record<string, unknown>) =>
        fn === "public_ledger" ? ([{ seq: 0 }] as T) : anyPublic.rpc<T>(fn, p),
    };
    expect(await loadLedger(ledgerDeps(broken), vault(1))).toEqual({
      status: "error",
      reason: "ledger",
      vault: vault(1),
      network: "mainnet",
    });
  });
});
