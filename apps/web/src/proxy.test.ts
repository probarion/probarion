import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { config, proxy } from "./proxy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GOOD_ID = "123e4567-e89b-42d3-a456-426614174000";

function req(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

describe("proxy", () => {
  it("sends a signed-out visitor from the console to /login, keeping only the path", () => {
    const res = proxy(req("/console/vaults/acme.near?tab=spends&x=https://evil.example"));
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin).toBe("http://localhost:3000");
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("next")).toBe("/console/vaults/acme.near");
    expect(to.search).not.toContain("evil");
  });

  it("covers /console itself and every path below it, but not look-alikes", () => {
    for (const p of ["/console", "/console/", "/console/a/b/c"]) {
      expect(proxy(req(p)).status, p).toBe(307);
    }
    for (const p of [
      "/consoles",
      "/consolex/y",
      "/",
      "/login",
      "/proof/v",
      "/api/auth/challenge",
    ]) {
      const res = proxy(req(p));
      expect(res.status, p).toBe(200);
      expect(res.headers.get("location"), p).toBeNull();
    }
  });

  it("lets a request with a session cookie through (the page checks the cookie itself)", () => {
    const res = proxy(req("/console/vaults/a.near", { cookie: `${SESSION_COOKIE}=anything` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    // a made-up cookie passes: the proxy is not the security boundary
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("uses the cookie name the session module sets", () => {
    expect(SESSION_COOKIE).toBe("pb_session");
    expect(proxy(req("/console", { cookie: "pb_session=x" })).status).toBe(200);
    expect(proxy(req("/console", { cookie: "pb_chal=x" })).status).toBe(307);
    expect(proxy(req("/console", { cookie: "other=pb_session" })).status).toBe(307);
  });

  it("keeps a request id that is a UUID and replaces anything else", () => {
    expect(proxy(req("/", { "x-request-id": GOOD_ID })).headers.get("x-request-id")).toBe(GOOD_ID);
    for (const bad of [
      "not-a-uuid",
      "x".repeat(500),
      "123e4567-e89b-42d3-a456-426614174000x",
      "",
    ]) {
      const id = proxy(req("/", { "x-request-id": bad })).headers.get("x-request-id") ?? "";
      expect(id, bad.slice(0, 20)).toMatch(UUID);
      expect(id).not.toBe(bad);
    }
    expect(proxy(req("/")).headers.get("x-request-id")).toMatch(UUID);
  });

  it("forwards the request id to the route on the request, not only on the response", () => {
    const res = proxy(req("/api/anything", { "x-request-id": "bad" }));
    const sent = res.headers.get("x-middleware-request-x-request-id");
    expect(sent).toBe(res.headers.get("x-request-id"));
    expect(sent).toMatch(UUID);
  });

  it("forwards the path, for pages that send a signed-out visitor to /login (never the query)", () => {
    const res = proxy(req("/console/vaults/acme.near?tab=spends", { cookie: "pb_session=x" }));
    expect(res.headers.get("x-middleware-request-x-pathname")).toBe("/console/vaults/acme.near");
    expect(res.headers.get("x-middleware-override-headers")).toContain("x-pathname");
  });

  it("overwrites an x-pathname the caller sent, so a page can trust it", () => {
    for (const forged of ["//evil.example", "/console/other", "https://evil.example/"]) {
      const res = proxy(req("/console/real", { cookie: "pb_session=x", "x-pathname": forged }));
      expect(res.headers.get("x-middleware-request-x-pathname")).toBe("/console/real");
    }
  });

  it("puts the request id on the redirect too", () => {
    const res = proxy(req("/console", { "x-request-id": GOOD_ID }));
    expect(res.headers.get("x-request-id")).toBe(GOOD_ID);
  });

  it("runs on pages and API routes but not on static assets", () => {
    const [matcher] = config.matcher;
    const re = new RegExp(`^${matcher}$`);
    for (const p of ["/", "/console", "/api/auth/verify", "/login"])
      expect(re.test(p), p).toBe(true);
    for (const p of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) {
      expect(re.test(p), p).toBe(false);
    }
  });
});
