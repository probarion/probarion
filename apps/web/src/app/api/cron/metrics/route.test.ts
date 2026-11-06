import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quietLogs } from "../../../../../test/fixtures/quiet-logs";

// The route with its settings and its database replaced. cronAuthorized, the response helpers and the logger are real.
const mocks = vi.hoisted(() => ({
  env: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.env }));
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => ({ rpc: mocks.rpc }) }));

import * as route from "./route";

const logs = quietLogs();

const SECRET = "c0ffee".repeat(8);
const URL_ = "https://probarion.example/api/cron/metrics";
const call = (headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) =>
  route.GET(new Request(URL_, { headers }));

beforeEach(() => {
  mocks.env.mockReset();
  mocks.rpc.mockReset();
  mocks.env.mockReturnValue({ NEAR_NETWORK: "mainnet", CRON_SECRET: SECRET });
  // The row data a log line must never carry: only the counts of a run may.
  mocks.rpc.mockImplementation(async (fn: string, p: { network: string; day: string }) =>
    fn === "rate_limits_prune"
      ? { deleted: 4 }
      : { day: p.day, network: p.network, rows: 7, leak: "ROW-DATA-MUST-NOT-BE-LOGGED" },
  );
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T00:10:03.500Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/cron/metrics", () => {
  it("is a GET route that is never cached and has a minute to run", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "maxDuration"]);
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(60);
  });

  it("answers 401 without the header, with a wrong secret and with a bare secret, and computes nothing", async () => {
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
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("answers 401 when the server's own secret is too short to be one", async () => {
    mocks.env.mockReturnValue({ NEAR_NETWORK: "mainnet", CRON_SECRET: "short" });
    const res = await call({ authorization: "Bearer short" });
    expect(res.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("computes yesterday and then today, in UTC, for the network the app runs on", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    // The two computes, then the prune of the rate limiter's old rows.
    expect(mocks.rpc.mock.calls).toEqual([
      ["metrics_compute", { network: "mainnet", day: "2026-11-05" }],
      ["metrics_compute", { network: "mainnet", day: "2026-11-06" }],
      ["rate_limits_prune", {}],
    ]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      ok: boolean;
      network: string;
      results: { day: string; rows: number }[];
      prune: { ok: boolean; deleted?: number };
    };
    expect(body.ok).toBe(true);
    expect(body.prune).toEqual({ ok: true, deleted: 4 });
    expect(body.network).toBe("mainnet");
    expect(body.results.map((r) => [r.day, r.rows])).toEqual([
      ["2026-11-05", 7],
      ["2026-11-06", 7],
    ]);
  });

  it("uses testnet when the app runs on testnet", async () => {
    mocks.env.mockReturnValue({ NEAR_NETWORK: "testnet", CRON_SECRET: SECRET });
    await call();
    const computes = mocks.rpc.mock.calls.filter(([fn]) => fn === "metrics_compute");
    expect(computes.map(([, p]) => p.network)).toEqual(["testnet", "testnet"]);
  });

  it("takes its days from the UTC clock at the edges of the day", async () => {
    vi.setSystemTime(new Date("2026-12-31T23:59:59.999Z"));
    await call();
    vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
    await call();
    const computes = mocks.rpc.mock.calls.filter(([fn]) => fn === "metrics_compute");
    expect(computes.map(([, p]) => p.day)).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2026-12-31",
      "2027-01-01",
    ]);
  });

  it("logs the network, the days and how many rows each run wrote, and no row data or secret", async () => {
    await call();
    const line = logs.lines.find((l) => l.includes("cron.metrics"));
    expect(line).toBeDefined();
    expect(line).toContain("mainnet");
    expect(line).toContain("2026-11-05");
    expect(line).toContain("2026-11-06");
    expect(line).toContain("[7,7]");
    expect(line).toContain("4"); // the rows the prune deleted
    expect(logs.lines.join("\n")).not.toContain("ROW-DATA-MUST-NOT-BE-LOGGED");
    expect(logs.lines.join("\n")).not.toContain(SECRET);
  });

  it("still answers 200 with both computes when the prune fails, and says so in the log and in the answer", async () => {
    mocks.rpc.mockImplementation(async (fn: string, p: { network: string; day: string }) => {
      if (fn === "rate_limits_prune") throw new Error("permission denied for table rate_limits");
      return { day: p.day, network: p.network, rows: 7 };
    });
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      results: { rows: number }[];
      prune: { ok: boolean; deleted?: number };
    };
    expect(body.ok).toBe(true);
    expect(body.results.map((r) => r.rows)).toEqual([7, 7]);
    expect(body.prune).toEqual({ ok: false });
    const warned = logs.lines.filter((l) => l.includes("cron.rate_limits_prune_failed"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("permission denied for table rate_limits");
    expect(warned[0]).toContain('"level":"warn"');
    // The computes were done and logged as they would be.
    expect(logs.lines.some((l) => l.includes("cron.metrics") && l.includes("[7,7]"))).toBe(true);
    expect(logs.lines.join("\n")).not.toContain(SECRET);
  });

  it("does not prune when a compute failed: the run is a failed run", async () => {
    mocks.rpc.mockReset();
    mocks.rpc.mockRejectedValueOnce(new Error("statement timeout"));
    const res = await call();
    expect(res.status).toBe(503);
    expect(mocks.rpc.mock.calls.map(([fn]) => fn)).toEqual(["metrics_compute"]);
  });

  it("logs no run for a request that was refused, and no secret", async () => {
    await call({ authorization: "Bearer wrong" });
    expect(logs.lines.join("\n")).not.toContain(SECRET);
    expect(logs.lines.filter((l) => l.includes("cron.metrics"))).toEqual([]);
  });

  it("answers 503 and logs the failure when the database fails, on either day", async () => {
    mocks.rpc.mockRejectedValueOnce(new Error("connection refused"));
    let res = await call();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("unavailable");
    expect(
      logs.lines.some((l) => l.includes("cron.metrics_failed") && l.includes("connection refused")),
    ).toBe(true);

    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValueOnce({ day: "2026-11-05", network: "mainnet", rows: 1 });
    mocks.rpc.mockRejectedValueOnce(new Error("statement timeout"));
    res = await call();
    expect(res.status).toBe(503);
    expect(logs.lines.join("\n")).not.toContain(SECRET);
  });

  it("answers 503 when the settings cannot be read, and does not call the database", async () => {
    mocks.env.mockImplementation(() => {
      throw new Error("Invalid environment: SUPABASE_URL is required");
    });
    const res = await call();
    expect(res.status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
