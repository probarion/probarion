import { beforeEach, describe, expect, it, vi } from "vitest";
import { quietLogs } from "../../../test/fixtures/quiet-logs";

// The kick and the deps with next/server, the settings, the database and the chain replaced. The logger is real.
const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  db: { rpc: vi.fn() },
  dbFails: false,
  readers: [] as string[],
  rpcs: [] as string[],
  watchTenantById: vi.fn(),
  runAlerts: vi.fn(),
  viewAccount: vi.fn(),
  reader: { name: "reader" },
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/db/clients", () => ({
  serviceDb: () => {
    if (mocks.dbFails) throw new Error("Invalid environment: SUPABASE_URL is required");
    return mocks.db;
  },
}));
vi.mock("@/lib/near/server", () => ({
  getReader: (network: string) => {
    mocks.readers.push(network);
    return mocks.reader;
  },
  getRpc: (network: string) => {
    mocks.rpcs.push(network);
    return { viewAccount: mocks.viewAccount };
  },
}));
vi.mock("./watch", () => ({ watchTenantById: mocks.watchTenantById }));
vi.mock("@/lib/alerts/server", () => ({ runAlerts: mocks.runAlerts }));

import { GRACE_AFTER_DEADLINE_MS } from "@/lib/alerts/dispatch";
import { PAYABLES_TIME } from "@/lib/payables/budget";
import { KICK_ALERTS_MS, kickWatcher, watcherDeps } from "./server";

const logs = quietLogs();

const TENANT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  for (const m of [mocks.after, mocks.watchTenantById, mocks.runAlerts, mocks.viewAccount]) {
    m.mockReset();
  }
  mocks.runAlerts.mockResolvedValue({ sent: 0, failed: 0, skipped: 0, deferred: 0, error: false });
  mocks.dbFails = false;
  mocks.readers = [];
  mocks.rpcs = [];
  mocks.after.mockImplementation(() => undefined);
  mocks.watchTenantById.mockResolvedValue({ inserted: 0 });
});

/** The callback the kick handed to after(). */
const registered = (): (() => Promise<void>) => {
  expect(mocks.after).toHaveBeenCalledTimes(1);
  return mocks.after.mock.calls[0]?.[0] as () => Promise<void>;
};

describe("watcherDeps", () => {
  it("is the server's database, the network's reader, the network, the clock and the network's view_account", async () => {
    mocks.viewAccount.mockResolvedValue({ amount: "5", storage_usage: 1 });
    const deps = watcherDeps("testnet");
    expect(deps.db).toBe(mocks.db);
    expect(deps.reader).toBe(mocks.reader);
    expect(deps.network).toBe("testnet");
    expect(deps.now()).toBeInstanceOf(Date);
    expect(await deps.viewAccount("v.near")).toEqual({ amount: "5", storage_usage: 1 });
    expect(mocks.viewAccount).toHaveBeenCalledWith("v.near");
    // Both the reader and the view_account went to testnet's chain client, and nothing to mainnet's.
    expect(mocks.readers).toEqual(["testnet"]);
    expect(mocks.rpcs).toEqual(["testnet"]);
  });

  it("is built for the network it is given, whichever that is", () => {
    expect(watcherDeps("mainnet").network).toBe("mainnet");
    expect(mocks.readers).toEqual(["mainnet"]);
  });
});

describe("kickWatcher", () => {
  // The console upload answers by PAYABLES_TIME.sendByMs plus its send window, and the kick then runs in what is left of
  // the route's 90 s: one tenant's watch, alerts claimed until KICK_ALERTS_MS after it, and a send started before
  // that deadline may run on until the dispatcher's grace after it (lib/alerts/dispatch.ts).
  it("fits in what a console upload leaves it once it has answered", () => {
    expect(
      PAYABLES_TIME.kickWatchMs + KICK_ALERTS_MS + GRACE_AFTER_DEADLINE_MS,
    ).toBeLessThanOrEqual(PAYABLES_TIME.afterResponseMs);
    expect(KICK_ALERTS_MS).toBe(10_000);
    expect(GRACE_AFTER_DEADLINE_MS).toBe(5_000);
  });

  it("hands one job to after() and does no work until the response is sent", () => {
    kickWatcher(TENANT, "mainnet");
    registered();
    expect(mocks.watchTenantById).not.toHaveBeenCalled();
    expect(mocks.readers).toEqual([]);
  });

  it("watches that tenant, on the tenant's network, when the job runs", async () => {
    kickWatcher(TENANT, "mainnet");
    await registered()();
    expect(mocks.watchTenantById).toHaveBeenCalledTimes(1);
    const [deps, id] = mocks.watchTenantById.mock.calls[0] as [{ network: string }, string];
    expect(id).toBe(TENANT);
    expect(deps.network).toBe("mainnet");
  });

  it("never throws out of the job: a failed watch is a warning with the tenant and the error", async () => {
    mocks.watchTenantById.mockRejectedValue(new Error("rpc down"));
    kickWatcher(TENANT, "mainnet");
    await expect(registered()()).resolves.toBeUndefined();
    const warned = logs.lines.filter((l) => l.includes("watch.kick_failed"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"level":"warn"');
    expect(warned[0]).toContain(TENANT);
    expect(warned[0]).toContain("rpc down");
  });

  it("does not throw when the settings cannot be read inside the job", async () => {
    mocks.dbFails = true;
    kickWatcher(TENANT, "mainnet");
    await expect(registered()()).resolves.toBeUndefined();
    expect(mocks.watchTenantById).not.toHaveBeenCalled();
    expect(logs.lines.some((l) => l.includes("watch.kick_failed"))).toBe(true);
  });

  describe("the owners' alerts", () => {
    it("go out after the watch, in the same job, with a deadline 10 s from when the job reached them", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
        const order: string[] = [];
        mocks.watchTenantById.mockImplementation(async () => {
          order.push("watch");
          vi.setSystemTime(new Date("2026-11-11T10:00:03Z")); // the watch took 3 s
          return { inserted: 1 };
        });
        mocks.runAlerts.mockImplementation(async () => {
          order.push("alerts");
          return { sent: 1, failed: 0, skipped: 0, deferred: 0, error: false };
        });
        kickWatcher(TENANT, "mainnet");
        await registered()();
        expect(order).toEqual(["watch", "alerts"]);
        expect(mocks.runAlerts).toHaveBeenCalledWith("mainnet", Date.parse("2026-11-11T10:00:13Z"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("still go out when the watch failed: what is already recorded is worth sending", async () => {
      mocks.watchTenantById.mockRejectedValue(new Error("rpc down"));
      kickWatcher(TENANT, "mainnet");
      await expect(registered()()).resolves.toBeUndefined();
      expect(mocks.runAlerts).toHaveBeenCalledTimes(1);
      expect(logs.lines.some((l) => l.includes("watch.kick_failed"))).toBe(true);
    });

    it("never fail the job, even if the dispatch rejects", async () => {
      mocks.runAlerts.mockRejectedValue(new Error("boom"));
      kickWatcher(TENANT, "mainnet");
      await expect(registered()()).resolves.toBeUndefined();
    });

    it("are not touched until the response is sent", () => {
      kickWatcher(TENANT, "mainnet");
      registered();
      expect(mocks.runAlerts).not.toHaveBeenCalled();
    });
  });

  // W-NET-R7: a kick watches and alerts the tenant's own network, and only that one.
  it("watches and alerts a testnet tenant on testnet alone, and a mainnet tenant on mainnet alone", async () => {
    for (const network of ["testnet", "mainnet"] as const) {
      mocks.after.mockReset();
      mocks.watchTenantById.mockClear();
      mocks.runAlerts.mockClear();
      mocks.readers = [];
      kickWatcher(TENANT, network);
      await registered()();
      expect(mocks.readers, network).toEqual([network]);
      const [deps] = mocks.watchTenantById.mock.calls[0] as [
        { network: string; viewAccount(a: string): Promise<unknown> },
      ];
      expect(deps.network).toBe(network);
      mocks.viewAccount.mockResolvedValue({ amount: "1", storage_usage: 1 });
      await deps.viewAccount("v.near");
      expect(mocks.rpcs.at(-1), network).toBe(network);
      expect(mocks.runAlerts.mock.calls[0]?.[0]).toBe(network);
    }
  });

  it("does not throw when after() refuses (called outside a request), so the request is not failed", () => {
    mocks.after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    expect(() => kickWatcher(TENANT, "mainnet")).not.toThrow();
    expect(logs.lines.some((l) => l.includes("watch.kick_failed"))).toBe(true);
  });
});
