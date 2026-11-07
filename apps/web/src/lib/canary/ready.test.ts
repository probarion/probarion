import { beforeEach, describe, expect, it, vi } from "vitest";
import { quietLogs } from "../../../test/fixtures/quiet-logs";

// `unstable_cache` needs the Next runtime. Here it records how it was called and runs the function it wraps at once,
// or fails the way a broken cache layer would.
const mocks = vi.hoisted(() => ({
  cached: [] as { keys: string[]; options: { revalidate?: number } }[],
  cacheFails: false,
  rpc: vi.fn(),
  head: vi.fn(),
  stores: [] as string[],
  keys: vi.fn(),
  accessKey: vi.fn(),
  readers: [] as string[],
}));

vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...a: unknown[]) => unknown,
    keys: string[],
    options: { revalidate?: number },
  ) => {
    mocks.cached.push({ keys, options });
    return (...args: unknown[]) => {
      if (mocks.cacheFails) return Promise.reject(new Error("cache layer down"));
      return fn(...args);
    };
  },
}));
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/ledger/store", () => ({
  SupabaseLedgerStore: class {
    constructor(_db: unknown, tenantId: string) {
      mocks.stores.push(tenantId);
    }
    head() {
      return mocks.head();
    }
  },
}));
vi.mock("@/lib/keys/service", () => ({ listKeys: mocks.keys }));
vi.mock("@/lib/near/server", () => ({
  getReader: (network: string) => {
    mocks.readers.push(network);
    return { accessKey: mocks.accessKey };
  },
}));

import { CANARY_LIMITS } from "./limits";
import { loadReadiness, READINESS_REVALIDATE_S, type ReadinessDeps, readinessOf } from "./ready";

const logs = quietLogs();

const VAULT = "canary.vaults.probarion.testnet";
const TENANT = { tenant_id: "t-1", vault_id: VAULT, network: "testnet" as const };
const ok = { ok: true as const, tenant: TENANT };
const FLOOR = CANARY_LIMITS.minLedgerAllowanceYocto;
/** A ledger whose head entry has sequence number `seq` (the entries are numbered from 0). */
const headAt = (seq: number) => ({ body: { seq } });

const deps = (over: Partial<ReadinessDeps> = {}): ReadinessDeps => ({
  tenant: async () => ok,
  ledgerSize: async () => 0,
  ledgerAllowance: async () => FLOOR,
  ...over,
});

describe("readinessOf", () => {
  it("is ready for a private Canary tenant on this network with room in its ledger and gas for its anchors", async () => {
    const tenant = vi.fn(async () => ok);
    const ledgerSize = vi.fn(async () => CANARY_LIMITS.maxLedgerEntries - 1);
    const ledgerAllowance = vi.fn(async () => FLOOR);
    expect(await readinessOf(deps({ tenant, ledgerSize, ledgerAllowance }), "testnet", VAULT)).toBe(
      "ready",
    );
    expect(tenant).toHaveBeenCalledWith("testnet", VAULT);
    expect(ledgerSize).toHaveBeenCalledWith(TENANT);
    expect(ledgerAllowance).toHaveBeenCalledWith(TENANT);
  });

  it("is ready with a ledger key the chain shows with no limit", async () => {
    expect(await readinessOf(deps({ ledgerAllowance: async () => null }), "testnet", VAULT)).toBe(
      "ready",
    );
  });

  it("is full once the ledger holds the most entries the Canary takes", async () => {
    const d = deps({ ledgerSize: async () => CANARY_LIMITS.maxLedgerEntries });
    expect(await readinessOf(d, "testnet", VAULT)).toBe("full");
  });

  it("is not open when the ledger key cannot pay for an anchor: under the floor, or no key (read as 0)", async () => {
    for (const allowance of [FLOOR - 1n, 0n]) {
      const d = deps({ ledgerAllowance: async () => allowance });
      expect(await readinessOf(d, "testnet", VAULT), String(allowance)).toBe("closed");
    }
  });

  it("is not open when the tenant check refuses, whatever the reason, and reads nothing else", async () => {
    for (const reason of ["not_canary", "other_network", "public_ledger"] as const) {
      const ledgerSize = vi.fn(async () => 0);
      const ledgerAllowance = vi.fn(async () => FLOOR);
      const d = deps({
        tenant: async () => ({ ok: false as const, reason }),
        ledgerSize,
        ledgerAllowance,
      });
      expect(await readinessOf(d, "testnet", VAULT), reason).toBe("closed");
      expect(ledgerSize).not.toHaveBeenCalled();
      expect(ledgerAllowance).not.toHaveBeenCalled();
    }
  });

  it("throws a failed read, so that it is never cached as an answer", async () => {
    const d = deps({ ledgerSize: async () => Promise.reject(new Error("db down")) });
    await expect(readinessOf(d, "testnet", VAULT)).rejects.toThrow("db down");
  });
});

describe("loadReadiness", () => {
  beforeEach(() => {
    mocks.cacheFails = false;
    mocks.rpc.mockReset();
    mocks.head.mockReset();
    mocks.keys.mockReset();
    mocks.accessKey.mockReset();
    mocks.stores = [];
    mocks.readers = [];
    mocks.rpc.mockResolvedValue({ ...TENANT, kind: "canary", proof_public: false });
    mocks.head.mockResolvedValue(null);
    mocks.keys.mockResolvedValue([
      { purpose: "agent", status: "active", public_key: "ed25519:agent" },
      { purpose: "ledger", status: "revoked", public_key: "ed25519:old" },
      { purpose: "ledger", status: "active", public_key: "ed25519:ledger" },
    ]);
    mocks.accessKey.mockResolvedValue({ exists: true, allowance: FLOOR.toString() });
  });

  it("reads the tenant, the ledger head and the ledger key with the service role, behind a cache of a minute", async () => {
    expect(await loadReadiness("testnet", VAULT)).toBe("ready");
    expect(mocks.rpc).toHaveBeenCalledWith("tenant_by_vault", { vault_id: VAULT });
    expect(mocks.stores).toEqual(["t-1"]);
    expect(mocks.keys).toHaveBeenCalledWith(expect.anything(), "t-1");
    expect(mocks.accessKey).toHaveBeenCalledWith(VAULT, "ed25519:ledger");
    expect(mocks.readers).toEqual(["testnet"]);
    expect(mocks.cached.filter((c) => c.keys.includes("canary-readiness"))).toEqual([
      { keys: ["canary-readiness"], options: { revalidate: 60 } },
    ]);
    expect(READINESS_REVALIDATE_S).toBe(60);
  });

  it("counts the entries from the head's sequence number", async () => {
    mocks.head.mockResolvedValue(headAt(CANARY_LIMITS.maxLedgerEntries - 2));
    expect(await loadReadiness("testnet", VAULT)).toBe("ready");
    mocks.head.mockResolvedValue(headAt(CANARY_LIMITS.maxLedgerEntries - 1));
    expect(await loadReadiness("testnet", VAULT)).toBe("full");
  });

  it("is not open when the tenant has no active ledger key, or the chain does not show it", async () => {
    mocks.keys.mockResolvedValue([{ purpose: "agent", status: "active", public_key: "x" }]);
    expect(await loadReadiness("testnet", VAULT)).toBe("closed");
    mocks.keys.mockResolvedValue([{ purpose: "ledger", status: "active", public_key: "y" }]);
    mocks.accessKey.mockResolvedValue({ exists: false, allowance: null });
    expect(await loadReadiness("testnet", VAULT)).toBe("closed");
  });

  it("is not open, with a warning, when the database or the chain cannot be read, and never throws", async () => {
    mocks.rpc.mockRejectedValue(new Error("db down"));
    expect(await loadReadiness("testnet", VAULT)).toBe("closed");
    mocks.rpc.mockResolvedValue({ ...TENANT, kind: "canary", proof_public: false });
    mocks.accessKey.mockRejectedValue(new Error("rpc down"));
    expect(await loadReadiness("testnet", VAULT)).toBe("closed");
    expect(logs.lines.filter((l) => l.includes("canary.readiness_unavailable"))).toHaveLength(2);
  });

  it("is not open when the cache layer itself fails", async () => {
    mocks.cacheFails = true;
    expect(await loadReadiness("testnet", VAULT)).toBe("closed");
    expect(logs.lines.filter((l) => l.includes("canary.readiness_unavailable"))).toHaveLength(1);
  });
});
