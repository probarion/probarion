import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quietLogs } from "../../../../../test/fixtures/quiet-logs";

// The route with its settings, the watcher's inputs and the watch itself replaced. cronAuthorized, the response helpers,
// the heartbeat, the health rule and the logger are real; the heartbeat's request goes to a stubbed fetch.
const mocks = vi.hoisted(() => ({
  env: vi.fn(),
  watchAll: vi.fn(),
  deps: { marker: "deps" },
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.env }));
vi.mock("@/lib/watcher/server", () => ({ watcherDeps: () => mocks.deps }));
vi.mock("@/lib/watcher/watch", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/watcher/watch")>()),
  watchAll: mocks.watchAll,
}));

import * as route from "./route";

const logs = quietLogs();

const SECRET = "c0ffee".repeat(8);
const BEAT = "https://uptime.betterstack.com/api/v1/heartbeat/TOKEN-IN-THE-PATH";
const URL_ = "https://probarion.example/api/cron/watch";
const call = (headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) =>
  route.GET(new Request(URL_, { headers }));
const run = (
  over: Partial<Record<"tenants" | "inserted" | "errors" | "skipped", number>> = {},
) => ({
  tenants: 3,
  inserted: 5,
  errors: 0,
  skipped: 0,
  ...over,
});

let beat: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.env.mockReset();
  mocks.watchAll.mockReset();
  mocks.env.mockReturnValue({
    NEAR_NETWORK: "mainnet",
    CRON_SECRET: SECRET,
    BETTERSTACK_HEARTBEAT_URL: BEAT,
  });
  mocks.watchAll.mockResolvedValue(run());
  beat = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", beat);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/cron/watch", () => {
  it("is a GET route that is never cached and has a minute to run", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "maxDuration"]);
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(60);
  });

  it("answers 401 without the header, with a wrong secret and with a bare secret, and watches nothing", async () => {
    const wrong: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${SECRET}x` },
      { authorization: SECRET },
    ];
    for (const headers of wrong) {
      const res = await call(headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(mocks.watchAll).not.toHaveBeenCalled();
    expect(beat).not.toHaveBeenCalled();
  });

  it("answers 401 when the server's own secret is too short to be one", async () => {
    mocks.env.mockReturnValue({ NEAR_NETWORK: "mainnet", CRON_SECRET: "short" });
    const res = await call({ authorization: "Bearer short" });
    expect(res.status).toBe(401);
    expect(mocks.watchAll).not.toHaveBeenCalled();
  });

  it("watches with the server's inputs and answers the counts", async () => {
    mocks.watchAll.mockResolvedValue(run({ tenants: 4, inserted: 9, errors: 1, skipped: 2 }));
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.watchAll).toHaveBeenCalledWith(mocks.deps);
    expect(await res.json()).toEqual({
      ok: true,
      network: "mainnet",
      watch: { tenants: 4, inserted: 9, errors: 1, skipped: 2 },
      heartbeat: true,
    });
  });

  it("sends the heartbeat when the run was healthy", async () => {
    await call();
    expect(beat).toHaveBeenCalledTimes(1);
    expect(beat.mock.calls[0]?.[0]).toBe(BEAT);
  });

  it("sends the heartbeat when there is no tenant to watch: the cron is alive", async () => {
    mocks.watchAll.mockResolvedValue(run({ tenants: 0, inserted: 0 }));
    const res = await call();
    expect(res.status).toBe(200);
    expect(beat).toHaveBeenCalledTimes(1);
  });

  it("sends the heartbeat while one tenant works, and not when every tenant that was tried failed", async () => {
    mocks.watchAll.mockResolvedValue(run({ tenants: 3, errors: 2 }));
    expect((await call()).status).toBe(200);
    expect(beat).toHaveBeenCalledTimes(1);

    beat.mockClear();
    mocks.watchAll.mockResolvedValue(run({ tenants: 3, inserted: 0, errors: 3 }));
    const res = await call();
    expect(beat).not.toHaveBeenCalled();
    // A run that reached no chain is a failed run for the cron's log, and still says what it did.
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      network: "mainnet",
      watch: { tenants: 3, inserted: 0, errors: 3, skipped: 0 },
      heartbeat: false,
    });
  });

  it("does not count the tenants a full run left for next time as ones that worked", async () => {
    mocks.watchAll.mockResolvedValue(run({ tenants: 5, inserted: 0, errors: 1, skipped: 4 }));
    const res = await call();
    expect(res.status).toBe(503);
    expect(beat).not.toHaveBeenCalled();
  });

  it("sends no request when no heartbeat is configured", async () => {
    mocks.env.mockReturnValue({
      NEAR_NETWORK: "mainnet",
      CRON_SECRET: SECRET,
      BETTERSTACK_HEARTBEAT_URL: null,
    });
    const res = await call();
    expect(res.status).toBe(200);
    expect(beat).not.toHaveBeenCalled();
    expect(((await res.json()) as { heartbeat: boolean }).heartbeat).toBe(false);
  });

  it("is still a good run when the heartbeat cannot be sent", async () => {
    beat.mockRejectedValue(new Error("connect ETIMEDOUT"));
    const res = await call();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { heartbeat: boolean }).heartbeat).toBe(false);
  });

  it("answers 503 and logs the failure when the tenants cannot be listed, and sends no heartbeat", async () => {
    mocks.watchAll.mockRejectedValue(new Error("connection refused"));
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(beat).not.toHaveBeenCalled();
    expect(
      logs.lines.some((l) => l.includes("cron.watch_failed") && l.includes("connection refused")),
    ).toBe(true);
  });

  it("answers 503 when the settings cannot be read, and watches nothing", async () => {
    mocks.env.mockImplementation(() => {
      throw new Error("Invalid environment: SUPABASE_URL is required");
    });
    const res = await call();
    expect(res.status).toBe(503);
    expect(mocks.watchAll).not.toHaveBeenCalled();
  });

  it("logs the network and the counts, and no secret, no heartbeat address and no event data", async () => {
    mocks.watchAll.mockResolvedValue({
      ...run({ tenants: 4, inserted: 9, errors: 1, skipped: 2 }),
      leak: "EVENT-DATA-MUST-NOT-BE-LOGGED",
    });
    await call();
    const line = logs.lines.find((l) => l.includes("cron.watch"));
    expect(line).toBeDefined();
    const entry = JSON.parse(line as string) as Record<string, unknown>;
    expect(entry).toMatchObject({
      network: "mainnet",
      tenants: 4,
      inserted: 9,
      errors: 1,
      skipped: 2,
      healthy: true,
      heartbeat: true,
    });
    const text = logs.lines.join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("TOKEN-IN-THE-PATH");
    expect(text).not.toContain("EVENT-DATA-MUST-NOT-BE-LOGGED");
  });

  it("logs no run for a request that was refused, and no secret", async () => {
    await call({ authorization: "Bearer wrong" });
    expect(logs.lines.join("\n")).not.toContain(SECRET);
    expect(logs.lines.filter((l) => l.includes("cron.watch"))).toEqual([]);
  });
});
