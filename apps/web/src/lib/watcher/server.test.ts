import { beforeEach, describe, expect, it, vi } from "vitest";
import { quietLogs } from "../../../test/fixtures/quiet-logs";

// The kick and the deps with next/server, the settings, the database and the chain replaced. The logger is real.
const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  env: vi.fn(),
  watchTenantById: vi.fn(),
  viewAccount: vi.fn(),
  db: { rpc: vi.fn() },
  reader: { name: "reader" },
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/env", () => ({ getEnv: mocks.env }));
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => mocks.db }));
vi.mock("@/lib/near/server", () => ({
  getReader: () => mocks.reader,
  getRpc: () => ({ viewAccount: mocks.viewAccount }),
}));
vi.mock("./watch", () => ({ watchTenantById: mocks.watchTenantById }));

import { kickWatcher, watcherDeps } from "./server";

const logs = quietLogs();

const TENANT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  for (const m of [mocks.after, mocks.env, mocks.watchTenantById, mocks.viewAccount]) m.mockReset();
  mocks.env.mockReturnValue({ NEAR_NETWORK: "mainnet" });
  mocks.after.mockImplementation(() => undefined);
  mocks.watchTenantById.mockResolvedValue({ inserted: 0 });
});

/** The callback the kick handed to after(). */
const registered = (): (() => Promise<void>) => {
  expect(mocks.after).toHaveBeenCalledTimes(1);
  return mocks.after.mock.calls[0]?.[0] as () => Promise<void>;
};

describe("watcherDeps", () => {
  it("is the server's database and reader, the app's network, the clock and the RPC's view_account", async () => {
    mocks.env.mockReturnValue({ NEAR_NETWORK: "testnet" });
    mocks.viewAccount.mockResolvedValue({ amount: "5", storage_usage: 1 });
    const deps = watcherDeps();
    expect(deps.db).toBe(mocks.db);
    expect(deps.reader).toBe(mocks.reader);
    expect(deps.network).toBe("testnet");
    expect(deps.now()).toBeInstanceOf(Date);
    expect(await deps.viewAccount("v.near")).toEqual({ amount: "5", storage_usage: 1 });
    expect(mocks.viewAccount).toHaveBeenCalledWith("v.near");
  });
});

describe("kickWatcher", () => {
  it("hands one job to after() and does no work until the response is sent", () => {
    kickWatcher(TENANT);
    registered();
    expect(mocks.watchTenantById).not.toHaveBeenCalled();
    expect(mocks.env).not.toHaveBeenCalled();
  });

  it("watches that tenant, on the app's network, when the job runs", async () => {
    kickWatcher(TENANT);
    await registered()();
    expect(mocks.watchTenantById).toHaveBeenCalledTimes(1);
    const [deps, id] = mocks.watchTenantById.mock.calls[0] as [{ network: string }, string];
    expect(id).toBe(TENANT);
    expect(deps.network).toBe("mainnet");
  });

  it("never throws out of the job: a failed watch is a warning with the tenant and the error", async () => {
    mocks.watchTenantById.mockRejectedValue(new Error("rpc down"));
    kickWatcher(TENANT);
    await expect(registered()()).resolves.toBeUndefined();
    const warned = logs.lines.filter((l) => l.includes("watch.kick_failed"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"level":"warn"');
    expect(warned[0]).toContain(TENANT);
    expect(warned[0]).toContain("rpc down");
  });

  it("does not throw when the settings cannot be read inside the job", async () => {
    mocks.env.mockImplementation(() => {
      throw new Error("Invalid environment: SUPABASE_URL is required");
    });
    kickWatcher(TENANT);
    await expect(registered()()).resolves.toBeUndefined();
    expect(mocks.watchTenantById).not.toHaveBeenCalled();
    expect(logs.lines.some((l) => l.includes("watch.kick_failed"))).toBe(true);
  });

  it("does not throw when after() refuses (called outside a request), so the request is not failed", () => {
    mocks.after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    expect(() => kickWatcher(TENANT)).not.toThrow();
    expect(logs.lines.some((l) => l.includes("watch.kick_failed"))).toBe(true);
  });
});
