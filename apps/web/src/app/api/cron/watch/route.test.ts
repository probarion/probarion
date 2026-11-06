import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quietLogs } from "../../../../../test/fixtures/quiet-logs";

// The route with its settings, the watcher's inputs, the watch itself and the alert dispatch replaced. cronAuthorized, the
// response helpers, the heartbeat, the health rule and the logger are real; the heartbeat's request goes to a stubbed fetch.
const mocks = vi.hoisted(() => ({
  env: vi.fn(),
  watchAll: vi.fn(),
  runAlerts: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.env }));
vi.mock("@/lib/alerts/server", () => ({ runAlerts: mocks.runAlerts }));
vi.mock("@/lib/watcher/server", () => ({
  watcherDeps: (network: string) => ({ marker: "deps", network }),
}));
vi.mock("@/lib/watcher/watch", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/watcher/watch")>()),
  watchAll: mocks.watchAll,
}));

import * as route from "./route";

const logs = quietLogs();

const SECRET = "c0ffee".repeat(8);
const BEAT = "https://uptime.betterstack.com/api/v1/heartbeat/TOKEN-IN-THE-PATH";
const URL_ = "https://probarion.example/api/cron/watch";
const ALERTS = { sent: 2, failed: 1, skipped: 0, deferred: 4, error: false };
const call = (headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) =>
  route.GET(new Request(URL_, { headers }));
const run = (
  over: Partial<Record<"tenants" | "inserted" | "errors" | "skipped" | "checkErrors", number>> = {},
) => ({
  tenants: 3,
  inserted: 5,
  errors: 0,
  skipped: 0,
  checkErrors: 0,
  ...over,
});
const env = (
  over: { enabledNetworks?: string[]; BETTERSTACK_HEARTBEAT_URL?: string | null } = {},
) => ({
  enabledNetworks: ["mainnet"],
  CRON_SECRET: SECRET,
  BETTERSTACK_HEARTBEAT_URL: BEAT,
  ...over,
});
const BOTH = ["mainnet", "testnet"];

type Body = {
  ok: boolean;
  networks: {
    network: string;
    watch: Record<string, unknown>;
    starved?: true;
    alerts: Record<string, unknown> | null;
  }[];
  heartbeat: boolean;
};

let beat: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.env.mockReset();
  mocks.watchAll.mockReset();
  mocks.runAlerts.mockReset();
  mocks.runAlerts.mockResolvedValue(ALERTS);
  mocks.env.mockReturnValue(env());
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
    expect(mocks.runAlerts).not.toHaveBeenCalled();
    expect(beat).not.toHaveBeenCalled();
  });

  it("answers 401 when the server's own secret is too short to be one", async () => {
    mocks.env.mockReturnValue({ ...env(), CRON_SECRET: "short" });
    const res = await call({ authorization: "Bearer short" });
    expect(res.status).toBe(401);
    expect(mocks.watchAll).not.toHaveBeenCalled();
  });

  it("watches with the network's inputs and answers the counts, per network", async () => {
    mocks.watchAll.mockResolvedValue(
      run({ tenants: 4, inserted: 9, errors: 1, skipped: 2, checkErrors: 3 }),
    );
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.watchAll).toHaveBeenCalledTimes(1);
    expect(mocks.watchAll.mock.calls[0]?.[0]).toEqual({ marker: "deps", network: "mainnet" });
    expect(await res.json()).toEqual({
      ok: true,
      networks: [
        {
          network: "mainnet",
          watch: { tenants: 4, inserted: 9, errors: 1, skipped: 2, checkErrors: 3 },
          alerts: ALERTS,
        },
      ],
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
      networks: [
        {
          network: "mainnet",
          watch: { tenants: 3, inserted: 0, errors: 3, skipped: 0, checkErrors: 0 },
          alerts: ALERTS,
        },
      ],
      heartbeat: false,
    });
  });

  it("does not let failed checks change the health of a run: the heartbeat still goes out", async () => {
    mocks.watchAll.mockResolvedValue(run({ tenants: 3, checkErrors: 12 }));
    const res = await call();
    expect(res.status).toBe(200);
    expect(beat).toHaveBeenCalledTimes(1);
    expect(((await res.json()) as Body).networks[0]?.watch.checkErrors).toBe(12);
  });

  it("does not count the tenants a full run left for next time as ones that worked", async () => {
    mocks.watchAll.mockResolvedValue(run({ tenants: 5, inserted: 0, errors: 1, skipped: 4 }));
    const res = await call();
    expect(res.status).toBe(503);
    expect(beat).not.toHaveBeenCalled();
  });

  it("sends no request when no heartbeat is configured", async () => {
    mocks.env.mockReturnValue(env({ BETTERSTACK_HEARTBEAT_URL: null }));
    const res = await call();
    expect(res.status).toBe(200);
    expect(beat).not.toHaveBeenCalled();
    expect(((await res.json()) as Body).heartbeat).toBe(false);
  });

  it("is still a good run when the heartbeat cannot be sent", async () => {
    beat.mockRejectedValue(new Error("connect ETIMEDOUT"));
    const res = await call();
    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).heartbeat).toBe(false);
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

  describe("the alerts", () => {
    it("are sent after the watch, with a deadline 55 s after the route started", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
        const order: string[] = [];
        mocks.watchAll.mockImplementation(async () => {
          order.push("watch");
          vi.setSystemTime(new Date("2026-11-11T10:00:20Z")); // the watch took 20 s
          return run();
        });
        mocks.runAlerts.mockImplementation(async () => {
          order.push("alerts");
          return ALERTS;
        });
        await call();
        expect(order).toEqual(["watch", "alerts"]);
        expect(mocks.runAlerts).toHaveBeenCalledTimes(1);
        expect(mocks.runAlerts).toHaveBeenCalledWith("mainnet", Date.parse("2026-11-11T10:00:55Z"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("are sent after an unhealthy run too: what is already recorded is still worth sending", async () => {
      mocks.watchAll.mockResolvedValue(run({ tenants: 3, errors: 3 }));
      const res = await call();
      expect(res.status).toBe(503);
      expect(mocks.runAlerts).toHaveBeenCalledTimes(1);
    });

    it("are not sent when the watch itself cannot run", async () => {
      mocks.watchAll.mockRejectedValue(new Error("connection refused"));
      expect((await call()).status).toBe(503);
      expect(mocks.runAlerts).not.toHaveBeenCalled();
    });

    it("never change the run's health, its status or its heartbeat when they fail", async () => {
      mocks.runAlerts.mockResolvedValue({
        sent: 0,
        failed: 0,
        skipped: 0,
        deferred: 0,
        error: true,
      });
      const res = await call();
      expect(res.status).toBe(200);
      const body = (await res.json()) as Body;
      expect(body).toMatchObject({
        ok: true,
        heartbeat: true,
        networks: [{ alerts: { error: true } }],
      });
      expect(beat).toHaveBeenCalledTimes(1);
      const line = JSON.parse(logs.lines.find((l) => l.includes("cron.watch")) as string);
      expect(line).toMatchObject({
        healthy: true,
        heartbeat: true,
        networks: [{ alerts: { error: true } }],
      });
    });

    it("never fail the route even if the dispatch itself rejects", async () => {
      mocks.runAlerts.mockRejectedValue(new Error("boom"));
      const res = await call();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        heartbeat: true,
        networks: [{ alerts: { sent: 0, failed: 0, skipped: 0, deferred: 0, error: true } }],
      });
      expect(beat).toHaveBeenCalledTimes(1);
    });

    it("are sent after the heartbeat, so a slow dispatch cannot hold it back", async () => {
      const order: string[] = [];
      beat.mockImplementation(async () => {
        order.push("heartbeat");
        return new Response("ok");
      });
      mocks.runAlerts.mockImplementation(async () => {
        order.push("alerts");
        return ALERTS;
      });
      await call();
      expect(order).toEqual(["heartbeat", "alerts"]);
    });

    it("are counted in the log line, and nothing of them but counts", async () => {
      await call();
      const entry = JSON.parse(logs.lines.find((l) => l.includes("cron.watch")) as string);
      expect(entry.networks[0].alerts).toEqual(ALERTS);
    });
  });

  it("logs the networks and the counts, and no secret, no heartbeat address and no event data", async () => {
    mocks.watchAll.mockResolvedValue({
      ...run({ tenants: 4, inserted: 9, errors: 1, skipped: 2, checkErrors: 3 }),
      leak: "EVENT-DATA-MUST-NOT-BE-LOGGED",
    });
    await call();
    const line = logs.lines.find((l) => l.includes("cron.watch"));
    expect(line).toBeDefined();
    const entry = JSON.parse(line as string) as Record<string, unknown>;
    expect(entry).toMatchObject({
      networks: [
        {
          network: "mainnet",
          watch: { tenants: 4, inserted: 9, errors: 1, skipped: 2, checkErrors: 3 },
        },
      ],
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

// W-NET-R7: one run over every network this site serves, mainnet first.
describe("GET /api/cron/watch with both networks served", () => {
  beforeEach(() => {
    mocks.env.mockReturnValue(env({ enabledNetworks: BOTH }));
  });

  const networksOf = (calls: unknown[][]) =>
    calls.map((c) => (c[0] as { network: string }).network);

  it("watches mainnet first, then testnet, and every watch comes before any alert", async () => {
    const order: string[] = [];
    mocks.watchAll.mockImplementation(async (deps: { network: string }) => {
      order.push(`watch ${deps.network}`);
      return run();
    });
    beat.mockImplementation(async () => {
      order.push("heartbeat");
      return new Response("ok");
    });
    mocks.runAlerts.mockImplementation(async (network: string) => {
      order.push(`alerts ${network}`);
      return ALERTS;
    });
    const res = await call();
    expect(res.status).toBe(200);
    expect(order).toEqual([
      "watch mainnet",
      "watch testnet",
      "heartbeat",
      "alerts mainnet",
      "alerts testnet",
    ]);
    expect(networksOf(mocks.watchAll.mock.calls)).toEqual(["mainnet", "testnet"]);
  });

  it("answers { ok, networks: [{ network, watch, alerts }], heartbeat }, mainnet first", async () => {
    mocks.watchAll
      .mockResolvedValueOnce(run({ tenants: 2, inserted: 1 }))
      .mockResolvedValueOnce(run({ tenants: 0, inserted: 0 }));
    mocks.runAlerts
      .mockResolvedValueOnce({ sent: 1, failed: 0, skipped: 0, deferred: 0, error: false })
      .mockResolvedValueOnce({ sent: 0, failed: 0, skipped: 0, deferred: 0, error: false });
    const res = await call();
    expect(await res.json()).toEqual({
      ok: true,
      networks: [
        {
          network: "mainnet",
          watch: { tenants: 2, inserted: 1, errors: 0, skipped: 0, checkErrors: 0 },
          alerts: { sent: 1, failed: 0, skipped: 0, deferred: 0, error: false },
        },
        {
          network: "testnet",
          watch: { tenants: 0, inserted: 0, errors: 0, skipped: 0, checkErrors: 0 },
          alerts: { sent: 0, failed: 0, skipped: 0, deferred: 0, error: false },
        },
      ],
      heartbeat: true,
    });
  });

  it("logs one line for the run, with each network's counts", async () => {
    await call();
    const lines = logs.lines.filter((l) => l.includes('"msg":"cron.watch"'));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string);
    expect(entry.networks.map((n: { network: string }) => n.network)).toEqual(BOTH);
    expect(entry).toMatchObject({ healthy: true, heartbeat: true });
  });

  describe("the 40 s of the watch are shared", () => {
    const at = (s: number) => new Date(Date.parse("2026-11-11T10:00:00Z") + s * 1000);
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(at(0));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("gives each network half to begin with: what is left divided by the networks not yet run", async () => {
      await call();
      expect(mocks.watchAll.mock.calls.map((c) => c[1])).toEqual([20_000, 40_000]);
    });

    it("passes an idle network's time on, and takes a busy one's out of the rest", async () => {
      mocks.watchAll.mockImplementationOnce(async () => {
        vi.setSystemTime(at(3)); // mainnet had nothing to do and took 3 s
        return run({ tenants: 0, inserted: 0 });
      });
      await call();
      expect(mocks.watchAll.mock.calls.map((c) => c[1])).toEqual([20_000, 37_000]);

      mocks.watchAll.mockReset();
      mocks.watchAll.mockResolvedValue(run());
      vi.setSystemTime(at(100));
      mocks.watchAll.mockImplementationOnce(async () => {
        vi.setSystemTime(at(100 + 28)); // mainnet used 28 s, more than its half
        return run();
      });
      await call();
      expect(mocks.watchAll.mock.calls.map((c) => c[1])).toEqual([20_000, 12_000]);
    });

    it("gives the second network no time at all when the first used it all: it is starved, and the run is not healthy", async () => {
      mocks.watchAll.mockImplementationOnce(async () => {
        vi.setSystemTime(at(45));
        return run();
      });
      mocks.watchAll.mockImplementationOnce(async (_d: unknown, budget: number) => {
        expect(budget).toBe(0);
        return run({ tenants: 4, inserted: 0, skipped: 4 }); // every tenant left for the next run
      });
      const res = await call();
      // BASE's status for a watch that is not healthy, with no heartbeat for the run, and the answer says which network.
      expect(res.status).toBe(503);
      expect(beat).not.toHaveBeenCalled();
      const body = (await res.json()) as Body;
      expect(body.ok).toBe(false);
      expect(body.heartbeat).toBe(false);
      expect(body.networks.map((n) => [n.network, n.starved])).toEqual([
        ["mainnet", undefined],
        ["testnet", true],
      ]);
      expect(body.networks[1]?.watch).toEqual({
        tenants: 4,
        inserted: 0,
        errors: 0,
        skipped: 4,
        checkErrors: 0,
      });
      // The events already recorded are still worth sending: both networks' alerts run, as after any unhealthy watch.
      expect(mocks.runAlerts.mock.calls.map((c) => c[0])).toEqual(BOTH);
      // The log line says it too.
      const line = logs.lines.find((l) => l.includes('"msg":"cron.watch"')) ?? "{}";
      expect(JSON.parse(line)).toMatchObject({ healthy: false, heartbeat: false });
      expect(JSON.parse(line).networks[1]).toMatchObject({ network: "testnet", starved: true });
    });

    it("does not call a network with no tenants starved, whatever time it got: nothing was left undone", async () => {
      mocks.watchAll.mockImplementationOnce(async () => {
        vi.setSystemTime(at(45));
        return run();
      });
      mocks.watchAll.mockImplementationOnce(async () => run({ tenants: 0, inserted: 0 }));
      const res = await call();
      expect(res.status).toBe(200);
      expect(beat).toHaveBeenCalledTimes(1);
      const body = (await res.json()) as Body;
      expect(body.networks.some((n) => "starved" in n)).toBe(false);
    });

    it("does not call a network starved when it watched some tenants and left others for the next run", async () => {
      mocks.watchAll.mockResolvedValue(run({ tenants: 4, skipped: 3 }));
      const res = await call();
      expect(res.status).toBe(200);
      expect(beat).toHaveBeenCalledTimes(1);
      expect(((await res.json()) as Body).networks.some((n) => "starved" in n)).toBe(false);
    });

    it("shares the time to 55 s the same way between the two dispatches", async () => {
      mocks.watchAll.mockImplementationOnce(async () => {
        vi.setSystemTime(at(10));
        return run();
      });
      mocks.runAlerts.mockImplementationOnce(async () => {
        vi.setSystemTime(at(20)); // mainnet's dispatch took 10 s
        return ALERTS;
      });
      await call();
      // At 10 s: 45 s are left to 55 s, half of them for mainnet. At 20 s: 35 s are left, all for testnet.
      expect(mocks.runAlerts.mock.calls).toEqual([
        ["mainnet", at(10).getTime() + 22_500],
        ["testnet", at(20).getTime() + 35_000],
      ]);
    });
  });

  describe("the heartbeat", () => {
    it("is sent only when every network's watch was healthy", async () => {
      mocks.watchAll.mockResolvedValue(run());
      expect((await call()).status).toBe(200);
      expect(beat).toHaveBeenCalledTimes(1);

      for (const failing of [0, 1]) {
        beat.mockClear();
        mocks.watchAll.mockReset();
        mocks.watchAll
          .mockResolvedValueOnce(failing === 0 ? run({ tenants: 3, errors: 3 }) : run())
          .mockResolvedValueOnce(failing === 1 ? run({ tenants: 3, errors: 3 }) : run());
        const res = await call();
        expect(res.status, `network ${failing}`).toBe(503);
        expect(beat, `network ${failing}`).not.toHaveBeenCalled();
        expect(((await res.json()) as Body).ok).toBe(false);
      }
    });
  });

  describe("one network failing", () => {
    it("does not stop the other: it is watched and alerted, and the run says which failed", async () => {
      mocks.watchAll
        .mockRejectedValueOnce(new Error("mainnet tenants cannot be listed"))
        .mockResolvedValueOnce(run({ tenants: 1, inserted: 2 }));
      const res = await call();
      expect(res.status).toBe(503);
      expect(beat).not.toHaveBeenCalled();
      expect(networksOf(mocks.watchAll.mock.calls)).toEqual(["mainnet", "testnet"]);
      // Only the network whose watch ran has its alerts sent.
      expect(mocks.runAlerts.mock.calls.map((c) => c[0])).toEqual(["testnet"]);
      expect(await res.json()).toEqual({
        ok: false,
        networks: [
          { network: "mainnet", watch: { error: true }, alerts: null },
          {
            network: "testnet",
            watch: { tenants: 1, inserted: 2, errors: 0, skipped: 0, checkErrors: 0 },
            alerts: ALERTS,
          },
        ],
        heartbeat: false,
      });
      expect(
        logs.lines.some(
          (l) =>
            l.includes("cron.watch_failed") &&
            l.includes("mainnet") &&
            l.includes("mainnet tenants cannot be listed"),
        ),
      ).toBe(true);
    });

    it("is the same when the second one fails", async () => {
      mocks.watchAll.mockResolvedValueOnce(run()).mockRejectedValueOnce(new Error("testnet down"));
      const res = await call();
      expect(res.status).toBe(503);
      expect(mocks.runAlerts.mock.calls.map((c) => c[0])).toEqual(["mainnet"]);
      expect(((await res.json()) as Body).networks.map((n) => n.watch)).toEqual([
        { tenants: 3, inserted: 5, errors: 0, skipped: 0, checkErrors: 0 },
        { error: true },
      ]);
    });

    it("is a failed run with no alerts when neither can be watched", async () => {
      mocks.watchAll.mockRejectedValue(new Error("connection refused"));
      const res = await call();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
      expect(mocks.runAlerts).not.toHaveBeenCalled();
      expect(beat).not.toHaveBeenCalled();
    });

    it("lets a failed dispatch on one network leave the other's alerts alone", async () => {
      mocks.runAlerts.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(ALERTS);
      const res = await call();
      expect(res.status).toBe(200);
      expect(((await res.json()) as Body).networks.map((n) => n.alerts)).toEqual([
        { sent: 0, failed: 0, skipped: 0, deferred: 0, error: true },
        ALERTS,
      ]);
    });
  });

  it("watches only the networks the site serves", async () => {
    mocks.env.mockReturnValue(env({ enabledNetworks: ["testnet"] }));
    await call();
    expect(networksOf(mocks.watchAll.mock.calls)).toEqual(["testnet"]);
    expect(mocks.runAlerts.mock.calls.map((c) => c[0])).toEqual(["testnet"]);
  });
});
