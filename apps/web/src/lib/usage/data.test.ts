import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quietLogs } from "../../../test/fixtures/quiet-logs";

// `unstable_cache` needs the Next runtime. Here it records how it was called and runs the function it wraps at once. It
// can also be made to fail the way a broken cache layer would: with a rejection, or with a throw before any promise.
const mocks = vi.hoisted(() => ({
  cached: [] as { keys: string[]; options: { revalidate?: number } }[],
  cacheFails: null as null | "reject" | "throw",
  service: vi.fn(),
  anon: vi.fn(),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...a: unknown[]) => unknown,
    keys: string[],
    options: { revalidate?: number },
  ) => {
    mocks.cached.push({ keys, options });
    return (...args: unknown[]) => {
      if (mocks.cacheFails === "reject") return Promise.reject(new Error("cache layer down"));
      if (mocks.cacheFails === "throw") throw new Error("cache layer down");
      return fn(...args);
    };
  },
}));
vi.mock("@/lib/db/clients", () => ({
  serviceDb: () => ({ rpc: mocks.service }),
  publicDb: () => ({ rpc: mocks.anon }),
}));

import { loadUsage, READ_TIMEOUT_MS, STALE_AFTER_MS, USAGE_REVALIDATE_S } from "./data";

const logs = quietLogs();

const NOW = new Date("2026-11-06T10:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const answer = (over: Record<string, unknown> = {}) => ({
  network: "mainnet",
  totals: [{ segment: "external", metric: "vaults", value: 2 }],
  recent: [],
  canary_participants: 4,
  external_owners: 2,
  team_vaults: 1,
  pilots: [],
  pilot_names: [],
  updated_at: minutesAgo(5),
  ...over,
});

beforeEach(() => {
  mocks.service.mockReset();
  mocks.anon.mockReset();
  mocks.cacheFails = null;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("how the usage numbers are cached", () => {
  it("keeps one entry for a minute, so the refresh runs inside it and at most about once a minute", () => {
    expect(mocks.cached).toHaveLength(1);
    expect(mocks.cached[0]?.options.revalidate).toBe(60);
    expect(USAGE_REVALIDATE_S).toBe(60);
    expect(mocks.cached[0]?.keys.join(" ")).toContain("usage");
  });

  it("says an hour is when numbers are stale, and 5 seconds is how long a read may take", () => {
    expect(STALE_AFTER_MS).toBe(60 * 60_000);
    expect(READ_TIMEOUT_MS).toBe(5000);
  });
});

describe("loadUsage", () => {
  it("reads the numbers of the network asked, with the public key and the last 7 days", async () => {
    mocks.anon.mockResolvedValue(answer());
    const usage = await loadUsage("mainnet");
    expect(mocks.anon).toHaveBeenCalledTimes(1);
    expect(mocks.anon).toHaveBeenCalledWith("public_usage_metrics", {
      network: "mainnet",
      days: 7,
    });
    expect(usage).toMatchObject({ network: "mainnet", external_owners: 2, canary_participants: 4 });
    expect(usage?.totals).toEqual([{ segment: "external", metric: "vaults", value: 2 }]);
  });

  it("asks for testnet when that is the network", async () => {
    mocks.anon.mockResolvedValue(answer({ network: "testnet" }));
    expect(await loadUsage("testnet")).toMatchObject({ network: "testnet" });
    expect(mocks.anon).toHaveBeenCalledWith("public_usage_metrics", {
      network: "testnet",
      days: 7,
    });
  });

  describe("refreshing", () => {
    it("does not compute when the newest row is less than an hour old", async () => {
      mocks.anon.mockResolvedValue(answer({ updated_at: minutesAgo(59) }));
      await loadUsage("mainnet");
      expect(mocks.service).not.toHaveBeenCalled();
      expect(mocks.anon).toHaveBeenCalledTimes(1);
    });

    it("does not compute at exactly an hour, and does a moment later", async () => {
      mocks.anon.mockResolvedValue(answer({ updated_at: minutesAgo(60) }));
      await loadUsage("mainnet");
      expect(mocks.service).not.toHaveBeenCalled();
      mocks.anon.mockResolvedValue(
        answer({ updated_at: new Date(NOW.getTime() - STALE_AFTER_MS - 1).toISOString() }),
      );
      mocks.service.mockResolvedValue({});
      await loadUsage("mainnet");
      expect(mocks.service).toHaveBeenCalledTimes(1);
    });

    it("computes today with the service role when the newest row is over an hour old, then reads again", async () => {
      mocks.anon
        .mockResolvedValueOnce(answer({ updated_at: minutesAgo(120), external_owners: 1 }))
        .mockResolvedValueOnce(answer({ updated_at: minutesAgo(0), external_owners: 3 }));
      mocks.service.mockResolvedValue({ day: "2026-11-06", network: "mainnet", rows: 4 });
      const usage = await loadUsage("mainnet");
      expect(mocks.service).toHaveBeenCalledTimes(1);
      expect(mocks.service).toHaveBeenCalledWith("metrics_compute", {
        network: "mainnet",
        day: "2026-11-06",
      });
      expect(mocks.anon).toHaveBeenCalledTimes(2);
      // The compute came between the two reads.
      const order = [
        mocks.anon.mock.invocationCallOrder[0],
        mocks.service.mock.invocationCallOrder[0],
        mocks.anon.mock.invocationCallOrder[1],
      ];
      expect(order).toEqual([...order].sort((a, b) => (a ?? 0) - (b ?? 0)));
      expect(usage?.external_owners).toBe(3);
      expect(usage?.updated_at).toBe(minutesAgo(0));
    });

    it("computes when nothing has been computed yet", async () => {
      mocks.anon
        .mockResolvedValueOnce(answer({ updated_at: null, totals: [] }))
        .mockResolvedValueOnce(answer());
      mocks.service.mockResolvedValue({});
      const usage = await loadUsage("mainnet");
      expect(mocks.service).toHaveBeenCalledTimes(1);
      expect(usage?.totals).toHaveLength(1);
    });

    it("computes the day it is in UTC, for the network asked", async () => {
      vi.setSystemTime(new Date("2026-12-31T23:59:59.999Z"));
      mocks.anon.mockResolvedValue(answer({ network: "testnet", updated_at: null }));
      mocks.service.mockResolvedValue({});
      await loadUsage("testnet");
      expect(mocks.service).toHaveBeenCalledWith("metrics_compute", {
        network: "testnet",
        day: "2026-12-31",
      });
    });

    it("still gives what exists, and logs a warning, when the compute throws", async () => {
      mocks.anon.mockResolvedValue(answer({ updated_at: minutesAgo(300), external_owners: 9 }));
      mocks.service.mockRejectedValue(new Error("permission denied"));
      const usage = await loadUsage("mainnet");
      expect(usage?.external_owners).toBe(9);
      expect(mocks.anon).toHaveBeenCalledTimes(1);
      const warned = logs.lines.filter((l) => l.includes("usage.refresh_failed"));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("permission denied");
    });

    it("still gives what exists when the service key is not set, as in a preview", async () => {
      mocks.anon.mockResolvedValue(answer({ updated_at: null, totals: [] }));
      mocks.service.mockImplementation(() => {
        throw new Error("Invalid environment: SUPABASE_SERVICE_ROLE_KEY is required");
      });
      expect(await loadUsage("mainnet")).toMatchObject({ totals: [], updated_at: null });
    });

    it("still gives what it read first when the second read fails", async () => {
      mocks.anon
        .mockResolvedValueOnce(answer({ updated_at: minutesAgo(90), external_owners: 5 }))
        .mockRejectedValueOnce(new Error("timeout"));
      mocks.service.mockResolvedValue({});
      expect((await loadUsage("mainnet"))?.external_owners).toBe(5);
      expect(logs.lines.filter((l) => l.includes("usage.refresh_failed"))).toHaveLength(1);
    });

    it("gives up on a compute that hangs after 5 seconds, and shows what exists", async () => {
      mocks.anon.mockResolvedValue(answer({ updated_at: minutesAgo(90), external_owners: 6 }));
      mocks.service.mockReturnValue(new Promise(() => {}));
      const pending = loadUsage("mainnet");
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending)?.external_owners).toBe(6);
      const warned = logs.lines.filter((l) => l.includes("usage.refresh_failed"));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("timed out");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not compute when the first answer is not an answer: it cannot tell how old the numbers are", async () => {
      mocks.anon.mockResolvedValue("garbage");
      expect(await loadUsage("mainnet")).toBeNull();
      expect(mocks.service).not.toHaveBeenCalled();
    });
  });

  describe("when the numbers cannot be read", () => {
    it("is null, and logs a warning, when the database throws", async () => {
      mocks.anon.mockRejectedValue(new Error("connection refused"));
      expect(await loadUsage("mainnet")).toBeNull();
      const warned = logs.lines.filter((l) => l.includes("usage.unavailable"));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("connection refused");
      expect(mocks.service).not.toHaveBeenCalled();
    });

    it("is null when the public key is not set, as in a preview", async () => {
      mocks.anon.mockImplementation(() => {
        throw new Error("Invalid environment: NEXT_PUBLIC_SUPABASE_URL is required");
      });
      expect(await loadUsage("mainnet")).toBeNull();
      expect(logs.lines.filter((l) => l.includes("usage.unavailable"))).toHaveLength(1);
    });

    it("is null when the answer is malformed, or for the other network", async () => {
      mocks.anon.mockResolvedValue(answer({ external_owners: -1 }));
      expect(await loadUsage("mainnet")).toBeNull();
      mocks.anon.mockResolvedValue(answer({ network: "testnet" }));
      expect(await loadUsage("mainnet")).toBeNull();
    });

    it("gives up on a read that hangs after 5 seconds", async () => {
      mocks.anon.mockReturnValue(new Promise(() => {}));
      const pending = loadUsage("mainnet");
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
      expect(await pending).toBeNull();
      const warned = logs.lines.filter((l) => l.includes("usage.unavailable"));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("timed out");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not cut off a read that answers in time", async () => {
      mocks.anon.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(answer()), READ_TIMEOUT_MS - 100)),
      );
      const pending = loadUsage("mainnet");
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 100);
      expect(await pending).toMatchObject({ external_owners: 2 });
      expect(logs.lines.filter((l) => l.includes("unavailable"))).toEqual([]);
    });

    it.each(["reject", "throw"] as const)(
      "gives no numbers, and logs a warning, when the cache %ss",
      async (how) => {
        mocks.cacheFails = how;
        mocks.anon.mockResolvedValue(answer());
        expect(await loadUsage("mainnet")).toBeNull();
        const warned = logs.lines.filter((l) => l.includes("usage.unavailable"));
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain("cache layer down");
      },
    );
  });
});
