import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/port";
import { assertSameOrigin, clientIp, json, problem, rateLimitOr429 } from "./http";

describe("http helpers", () => {
  it("takes the first X-Forwarded-For hop", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe(
      "203.0.113.7",
    );
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(new Headers())).toBe("0.0.0.0");
  });

  it("rejects cross-origin and origin-less state changes", () => {
    const ok = new Request("https://probarion.xyz/api/x", {
      method: "POST",
      headers: { origin: "https://probarion.xyz", host: "probarion.xyz" },
    });
    const evil = new Request("https://probarion.xyz/api/x", {
      method: "POST",
      headers: { origin: "https://evil.example", host: "probarion.xyz" },
    });
    const none = new Request("https://probarion.xyz/api/x", {
      method: "POST",
      headers: { host: "probarion.xyz" },
    });
    expect(assertSameOrigin(ok)).toBeNull();
    expect(assertSameOrigin(evil)?.status).toBe(403);
    expect(assertSameOrigin(none)?.status).toBe(403);
  });

  it("formats problems as JSON with an error code", async () => {
    const r = problem(400, "invalid_input", "amount is required");
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_input", detail: "amount is required" });
  });
});

describe("http helpers: edges", () => {
  const xff = (v: string) => clientIp(new Headers({ "x-forwarded-for": v }));

  it("keeps a bucket key short and plain: only an IP-shaped hop is used", () => {
    expect(xff("2001:db8::1, 10.0.0.1")).toBe("2001:db8:0:0::/64");
    expect(xff("203.0.113.7")).toBe("203.0.113.7");
    // Garbage, an over-long hop or injected bucket syntax falls back to the shared bucket.
    for (const bad of ["x".repeat(500), "1.2.3.4:evil", "a b", "<script>", "unknown"]) {
      expect(xff(bad), bad).toBe("0.0.0.0");
    }
    // A bad X-Forwarded-For does not hide a good X-Real-IP.
    expect(
      clientIp(new Headers({ "x-forwarded-for": "garbage", "x-real-ip": "198.51.100.2" })),
    ).toBe("198.51.100.2");
    expect(clientIp(new Headers({ "x-real-ip": "x".repeat(100) }))).toBe("0.0.0.0");
  });

  // An IPv6 customer holds a whole /64 (often a /56 or /48), so one machine can rotate through 2^64 addresses. Rate-limit
  // buckets are per /64, or a limiter keyed on the full address would never fire against a single IPv6 attacker.
  it("buckets IPv6 by /64, so an attacker cannot dodge a limit by rotating addresses", () => {
    const sameNet = [
      "2001:db8:1:2::1",
      "2001:db8:1:2::ffff",
      "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
      "2001:0db8:0001:0002:0000:0000:0000:0001",
      "2001:DB8:1:2:0:0:0:9",
    ];
    for (const a of sameNet) expect(xff(a), a).toBe("2001:db8:1:2::/64");
    // A different /64 is a different bucket.
    expect(xff("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(xff("2001:db8:2:2::1")).toBe("2001:db8:2:2::/64");
    // Compressed and unspecified forms expand correctly.
    expect(xff("::1")).toBe("0:0:0:0::/64");
    expect(xff("1::")).toBe("1:0:0:0::/64");
    expect(xff("1:2:3:4:5:6:7:8")).toBe("1:2:3:4::/64");
    expect(xff("fe80::1")).toBe("fe80:0:0:0::/64");
    // The key stays short and plain whatever the input.
    expect(xff("2001:db8:1:2:aaaa:bbbb:cccc:dddd").length).toBeLessThan(40);
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 client it is", () => {
    // Bucketing these by /64 would put every IPv4 client behind a dual-stack proxy in one bucket.
    expect(xff("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(xff("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(xff("::FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(xff("::ffff:203.0.113.8")).not.toBe(xff("::ffff:203.0.113.7"));
    // Other embedded dotted quads are still read as IPv6 (here NAT64), bucketed by their /64.
    expect(xff("64:ff9b::203.0.113.7")).toBe("64:ff9b:0:0::/64");
  });

  it("rejects malformed addresses instead of guessing", () => {
    const bad = [
      "1::2::3", // two compressions
      ":::",
      "12345::1", // a group over 4 digits
      "g::1",
      "1:2:3:4:5:6:7:8:9", // nine groups
      "1:2:3:4:5:6:7", // seven groups and no ::
      "1:2:3:4:5:6:7:8::", // :: standing for nothing
      "::ffff:999.1.1.1", // dotted quad octet over 255
      "::ffff:1.2.3",
      "999.1.1.1",
      "1.2.3.4.5",
      "1.2.3",
      "1.2.3.1234",
      "[::1]",
      "fe80::1%eth0",
    ];
    for (const a of bad) expect(xff(a), a).toBe("0.0.0.0");
  });

  it("writes an IPv4 address in one canonical form", () => {
    expect(xff("001.002.003.004")).toBe("1.2.3.4");
    expect(xff("203.0.113.7")).toBe("203.0.113.7");
  });

  it("uses the forwarded host (first hop) behind a proxy, and refuses a mismatch or a malformed origin", () => {
    const post = (headers: Record<string, string>) =>
      new Request("https://internal.local/api/x", { method: "POST", headers });
    expect(
      assertSameOrigin(
        post({
          origin: "https://probarion.xyz",
          "x-forwarded-host": "probarion.xyz, cdn.example",
        }),
      ),
    ).toBeNull();
    expect(
      assertSameOrigin(post({ origin: "https://probarion.xyz", "x-forwarded-host": "other.xyz" }))
        ?.status,
    ).toBe(403);
    // A sandboxed iframe or a file page sends `Origin: null`.
    expect(assertSameOrigin(post({ origin: "null", host: "probarion.xyz" }))?.status).toBe(403);
    expect(assertSameOrigin(post({ origin: "not a url", host: "probarion.xyz" }))?.status).toBe(
      403,
    );
    // A suffix or prefix of the host is not the host.
    expect(
      assertSameOrigin(
        post({ origin: "https://probarion.xyz.evil.example", host: "probarion.xyz" }),
      )?.status,
    ).toBe(403);
    expect(
      assertSameOrigin(post({ origin: "https://evilprobarion.xyz", host: "probarion.xyz" }))
        ?.status,
    ).toBe(403);
    // A port is part of the host.
    expect(
      assertSameOrigin(post({ origin: "http://localhost:3000", host: "localhost:3000" })),
    ).toBeNull();
    expect(
      assertSameOrigin(post({ origin: "http://localhost:3001", host: "localhost:3000" }))?.status,
    ).toBe(403);
  });

  it("json sets no-store and lets a caller add headers", async () => {
    const r = json({ a: 1 }, 201, { "x-extra": "1" });
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect(r.headers.get("x-extra")).toBe("1");
    expect(await r.json()).toEqual({ a: 1 });
  });

  it("json merges any form of header init: a Headers object, pairs or a record", () => {
    const fromHeaders = json({}, 200, new Headers({ "x-a": "1", "x-b": "2" }));
    expect(fromHeaders.headers.get("x-a")).toBe("1");
    expect(fromHeaders.headers.get("x-b")).toBe("2");
    expect(fromHeaders.headers.get("cache-control")).toBe("no-store");
    const fromPairs = json({}, 200, [
      ["x-a", "1"],
      ["Retry-After", "30"],
    ]);
    expect(fromPairs.headers.get("x-a")).toBe("1");
    expect(fromPairs.headers.get("retry-after")).toBe("30");
    expect(fromPairs.headers.get("content-type")).toMatch(/^application\/json/);
    // A caller may override a default, in any header-name case.
    const overridden = json({}, 200, { "Cache-Control": "private, max-age=60" });
    expect(overridden.headers.get("cache-control")).toBe("private, max-age=60");
    // problem() passes its headers through the same way.
    expect(
      problem(429, "rate_limited", "x", new Headers({ "Retry-After": "5" })).headers.get(
        "retry-after",
      ),
    ).toBe("5");
  });

  it("json keeps every Set-Cookie of a Headers object", () => {
    const h = new Headers();
    h.append("set-cookie", "a=1; Path=/");
    h.append("set-cookie", "b=2; Path=/");
    const r = json({}, 200, h);
    expect(r.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("problem omits detail when there is none", async () => {
    expect(await problem(403, "bad_origin").json()).toEqual({ error: "bad_origin" });
  });
});

describe("rateLimitOr429 with a stub database", () => {
  const stub = (decision: unknown): Db => ({ rpc: async <T>() => decision as T });

  it("lets an allowed hit through without a response", async () => {
    const db = stub({ allowed: true, remaining: 4, reset_at: new Date().toISOString() });
    expect(await rateLimitOr429(db, "b", [5, 60])).toBeNull();
  });

  it("rounds Retry-After up to whole seconds from the reset time", async () => {
    const db = stub({
      allowed: false,
      remaining: 0,
      reset_at: new Date(Date.now() + 29_500).toISOString(),
    });
    const res = await rateLimitOr429(db, "b", [5, 60]);
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBe("30");
  });

  it("never gives less than 1 second, even when the database clock is ahead of ours", async () => {
    const db = stub({
      allowed: false,
      remaining: 0,
      reset_at: new Date(Date.now() - 5_000).toISOString(),
    });
    expect((await rateLimitOr429(db, "b", [5, 60]))?.headers.get("Retry-After")).toBe("1");
  });

  it("falls back to the window length when the reset time cannot be read", async () => {
    const db = stub({ allowed: false, remaining: 0, reset_at: "not a date" });
    const res = await rateLimitOr429(db, "b", [5, 600]);
    expect(res?.headers.get("Retry-After")).toBe("600");
  });

  it("passes the bucket, max and window to the database", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const db: Db = {
      rpc: async <T>(fn: string, p?: Record<string, unknown>) => {
        calls.push([fn, p]);
        return { allowed: true, remaining: 0, reset_at: new Date().toISOString() } as T;
      },
    };
    await rateLimitOr429(db, "auth:challenge:1.2.3.4", [20, 60]);
    expect(calls).toEqual([
      ["rate_limit_take", { bucket: "auth:challenge:1.2.3.4", max: 20, window_seconds: 60 }],
    ]);
  });
});
