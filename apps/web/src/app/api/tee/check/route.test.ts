import { PREFERRED_PRIVATE_MODELS } from "@probarion/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@/lib/ratelimit";
import { quietLogs } from "../../../../../test/fixtures/quiet-logs";
import {
  FAKE_NEARAI,
  fakeReportServer,
  fakeVerifier,
  NONCE,
} from "../../../../../test/fixtures/tee";

const h = vi.hoisted(() => ({
  model: "test-double/private-tee-model" as string | null,
  envThrows: false,
  limiterDown: false,
  rpcs: [] as { fn: string; p: Record<string, unknown> }[],
  buckets: new Map<string, number>(),
  checks: [] as { nonce: string; models: readonly string[] }[],
}));

// Every database call the route makes goes through here: the test holds it to the one rate-limit bucket.
vi.mock("@/lib/db/clients", () => ({
  serviceDb: () => ({
    rpc: async (fn: string, p: Record<string, unknown>) => {
      h.rpcs.push({ fn, p });
      if (fn !== "rate_limit_take") throw new Error(`unexpected rpc ${fn}`);
      if (h.limiterDown) throw new Error("db down");
      const bucket = String(p.bucket);
      const n = (h.buckets.get(bucket) ?? 0) + 1;
      h.buckets.set(bucket, n);
      return {
        allowed: n <= Number(p.max),
        remaining: Math.max(0, Number(p.max) - n),
        reset_at: new Date(Date.now() + 30_000).toISOString(),
      };
    },
  }),
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => {
    if (h.envThrows) throw new Error("Invalid environment: SUPABASE_URL is required");
    return { NEARAI_MODEL: h.model };
  },
}));
// The real check, run against the test doubles of NEAR AI and of the verifier.
const server = fakeReportServer();
const verifier = fakeVerifier();
vi.mock("@/lib/tee/check", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/tee/check")>();
  return {
    ...real,
    checkTee: (nonce: string, models: readonly string[]) => {
      h.checks.push({ nonce, models });
      return real.checkTee(nonce, models, {
        fetch: server.fetch,
        loadVerifier: async () => verifier,
        baseUrl: FAKE_NEARAI,
      });
    },
  };
});

const { GET } = await import("./route");

const logs = quietLogs();
const get = (query: string) => GET(new Request(`http://localhost:3100/api/tee/check${query}`));

beforeEach(() => {
  h.model = "test-double/private-tee-model";
  h.envThrows = false;
  h.limiterDown = false;
  h.rpcs = [];
  h.buckets.clear();
  h.checks = [];
  server.calls.length = 0;
});

describe("GET /api/tee/check", () => {
  it("answers 400 to anything but one nonce of 64 lowercase hex, and counts and asks nothing", async () => {
    for (const q of [
      "",
      "?nonce=",
      "?nonce=abc",
      `?nonce=${NONCE.toUpperCase()}`,
      `?nonce=${NONCE}0`,
      `?nonce=${NONCE.slice(1)}`,
      `?nonce=0x${NONCE.slice(2)}`,
      `?nonce=${NONCE}&nonce=${NONCE}`,
      `?nonce=${NONCE.slice(0, 63)}g`,
      `?nonce=${encodeURIComponent(`${NONCE} `)}`,
    ]) {
      const r = await get(q);
      expect(r.status, q).toBe(400);
      expect(r.headers.get("cache-control"), q).toBe("no-store");
      expect(await r.json(), q).toEqual({
        error: "invalid_input",
        detail: "Send one nonce: 64 lowercase hex characters.",
      });
    }
    expect(h.rpcs).toEqual([]);
    expect(h.checks).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("answers 200 with the checks, no-store, for the nonce asked, against NEARAI_MODEL", async () => {
    const r = await get(`?nonce=${NONCE}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as { nonce: string; model: string; checks: { status: string }[] };
    expect(body.nonce).toBe(NONCE);
    expect(body.model).toBe("test-double/private-tee-model");
    expect(body.checks.map((c) => c.status)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(h.checks).toEqual([{ nonce: NONCE, models: ["test-double/private-tee-model"] }]);
  });

  it("asks the SDK's preferred models in order when NEARAI_MODEL is not set", async () => {
    h.model = null;
    await get(`?nonce=${NONCE}`);
    expect(h.checks[0]?.models).toEqual(PREFERRED_PRIVATE_MODELS);
  });

  it("writes nothing to the database but its one global rate-limit bucket, which names no visitor", async () => {
    await GET(
      new Request(`http://localhost:3100/api/tee/check?nonce=${NONCE}`, {
        headers: { "x-forwarded-for": "203.0.113.7", cookie: "pb_session=abc" },
      }),
    );
    expect(h.rpcs).toEqual([
      {
        fn: "rate_limit_take",
        p: { bucket: "tee:check", max: LIMITS.teeCheck[0], window_seconds: LIMITS.teeCheck[1] },
      },
    ]);
    expect(JSON.stringify(h.rpcs)).not.toContain("203.0.113");
    expect(JSON.stringify(h.rpcs)).not.toContain(NONCE);
  });

  it("answers 429 rate_limited with Retry-After once all visitors together used the limit, and asks NEAR AI nothing", async () => {
    const [max] = LIMITS.teeCheck;
    for (let i = 0; i < max; i++) expect((await get(`?nonce=${NONCE}`)).status).toBe(200);
    const calls = server.calls.length;
    const r = await get(`?nonce=${NONCE}`);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^[0-9]+$/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = (await r.json()) as { error: string; detail: string };
    expect(body.error).toBe("rate_limited");
    expect(body.detail).toMatch(/^Try again in [0-9]+ s$/);
    expect(server.calls.length).toBe(calls);
    expect(h.checks).toHaveLength(max);
  });

  it("answers 503 unavailable when the limiter or the settings cannot be read, and checks nothing", async () => {
    h.limiterDown = true;
    const down = await get(`?nonce=${NONCE}`);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "unavailable", detail: "Try again in a minute." });
    h.limiterDown = false;
    h.envThrows = true;
    expect((await get(`?nonce=${NONCE}`)).status).toBe(503);
    expect(h.checks).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("logs neither the nonce nor the answer", async () => {
    await get(`?nonce=${NONCE}`);
    h.limiterDown = true;
    await get(`?nonce=${NONCE}`);
    const text = logs.lines.join("\n");
    expect(text).not.toContain(NONCE);
    expect(text).not.toContain("report_data");
    expect(text).not.toContain("signing_address");
  });

  it("runs on Node, is never cached, and has the time its check needs", async () => {
    const route = await import("./route");
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    const { TEE_CHECK_BUDGET_MS } = await import("@/lib/tee/limits");
    expect(route.maxDuration * 1000).toBeGreaterThan(TEE_CHECK_BUDGET_MS + 5000);
  });
});
