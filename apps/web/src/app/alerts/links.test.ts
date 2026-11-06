import type { PGlite } from "@electric-sql/pglite";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stopLinks, stopToken } from "@/lib/alerts/stop";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { freshDb, seedTenant } from "../../../test/db/harness";
import { pgliteDb } from "../../../test/db/pglite-db";
import { quietLogs } from "../../../test/fixtures/quiet-logs";

// The public pages an alert email links to, and the routes behind their buttons: confirm an address, stop a subscription.
// The database is PGlite, so the real SQL answers; the key is a test master; the response helpers, the limiter and the
// logger are real.
const h = vi.hoisted(() => ({ db: null as unknown as Db, ip: "203.0.113.5" }));
const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));

vi.mock("@/lib/db/clients", () => ({ serviceDb: () => h.db }));
vi.mock("@/lib/crypto/server", () => ({
  subkey: (purpose: Parameters<typeof deriveSubkey>[1]) => deriveSubkey(MASTER, purpose),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": h.ip }),
}));

import * as confirmRoute from "../api/alerts/confirm/route";
import * as stopRoute from "../api/alerts/stop/route";
import ConfirmPage, { metadata as confirmMetadata } from "./confirm/page";
import StopPage, { metadata as stopMetadata } from "./stop/page";

const logs = quietLogs();

const V = "acme.vaults.probarion.near";
const ORIGIN = "https://probarion.xyz";
let pg: PGlite;
let tenant: string;

beforeAll(async () => {
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "probarion.xyz");
  pg = await freshDb();
  h.db = pgliteDb(pg);
  tenant = await seedTenant(pg, { vault: V, owner: "acme.near" });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});
beforeEach(async () => {
  await pg.exec("delete from alert_subscriptions; delete from rate_limits;");
  h.db = pgliteDb(pg);
  h.ip = "203.0.113.5";
});

const html = (el: unknown) => renderToStaticMarkup(el as ReactElement).replaceAll("&#x27;", "'");
const createEmail = async () =>
  h.db.rpc<{ id: string; link_code: string }>("alert_subscription_create", {
    tenant_id: tenant,
    channel: "email",
    target: "owner@example.com",
    created_by: "acme.near",
  });
const row = async (id: string) =>
  (
    await pg.query<{ active: boolean; verified_at: string | null; link_code: string | null }>(
      "select active, verified_at, link_code from alert_subscriptions where id = $1",
      [id],
    )
  ).rows[0];
const confirmPage = (searchParams: Record<string, string | string[] | undefined>) =>
  ConfirmPage({ searchParams: Promise.resolve(searchParams) });
const stopPage = (searchParams: Record<string, string | string[] | undefined>) =>
  StopPage({ searchParams: Promise.resolve(searchParams) });
const post = (
  route: { POST: (req: Request) => Promise<Response> },
  url: string,
  form: Record<string, string> = {},
) =>
  route.POST(
    new Request(url, {
      method: "POST",
      headers: { "x-forwarded-for": h.ip },
      body: new URLSearchParams(form),
    }),
  );
const location = (res: Response) => res.headers.get("location");

describe("/alerts/confirm", () => {
  it("is not indexed", () => {
    expect(confirmMetadata.robots).toEqual({ index: false, follow: false });
  });

  it("names the vault and offers a button that POSTs, and uses nothing up by showing it", async () => {
    const { id, link_code } = await createEmail();
    const out = html(await confirmPage({ code: link_code }));
    expect(out).toContain(`Confirm alerts for ${V}?`);
    expect(out).toMatch(
      /<form[^>]*method="post"[^>]*action="\/api\/alerts\/confirm"|<form[^>]*action="\/api\/alerts\/confirm"[^>]*method="post"/,
    );
    expect(out).toContain(`name="code" value="${link_code}"`);
    expect(out).toContain("Confirm");
    // two views, and the link still works: a mail scanner that opens it changes nothing
    html(await confirmPage({ code: link_code }));
    expect(await row(id)).toMatchObject({ verified_at: null, active: true, link_code });
  });

  it("says one plain sentence for a link that is used, expired, unknown, mistyped or missing, and shows no form", async () => {
    const used = await createEmail();
    await post(confirmRoute, `${ORIGIN}/api/alerts/confirm`, { code: used.link_code });
    const old = await createEmail();
    await pg.query(
      "update alert_subscriptions set created_at = now() - interval '25 hours' where id = $1",
      [old.id],
    );
    for (const code of [
      used.link_code,
      old.link_code,
      "0".repeat(32),
      "nope",
      "",
      undefined,
      ["a", "b"],
      "<script>",
    ]) {
      const out = html(await confirmPage({ code }));
      expect(out, String(code)).toContain("This link has expired or was already used.");
      expect(out, String(code)).not.toContain("<form");
      expect(out, String(code)).not.toContain("<script>");
    }
  });

  it("sends no database call for a code that is not 32 lowercase hex characters", async () => {
    const rpc = vi.fn();
    h.db = { rpc } as unknown as Db;
    for (const code of ["", "short", "G".repeat(32), "A".repeat(32), "a".repeat(33), "../etc"]) {
      expect(html(await confirmPage({ code }))).toContain("expired or was already used");
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("says it cannot check right now, rather than that the link expired, when the database is down", async () => {
    h.db = { rpc: async () => Promise.reject(new Error("connection refused")) } as unknown as Db;
    const out = html(await confirmPage({ code: "a".repeat(32) }));
    expect(out).toContain("could not be checked right now");
    expect(out).not.toContain("expired");
    expect(out).not.toContain("connection refused");
  });

  it("says to wait when one address has asked too often", async () => {
    await pg.query(
      "insert into rate_limits (bucket, window_start, count) values ('alerts:link:203.0.113.5', now(), 30)",
    );
    const out = html(await confirmPage({ code: "a".repeat(32) }));
    expect(out).toContain("Too many tries");
  });
});

describe("POST /api/alerts/confirm", () => {
  it("confirms the address, uses the code up and sends the person to the vault's alerts page", async () => {
    const { id, link_code } = await createEmail();
    const res = await post(confirmRoute, `${ORIGIN}/api/alerts/confirm`, { code: link_code });
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${ORIGIN}/console/${V}/alerts?verified=1`);
    expect(await row(id)).toMatchObject({ active: true, link_code: null });
    expect((await row(id))?.verified_at).not.toBeNull();
    // the same form posted again finds nothing to confirm
    const again = await post(confirmRoute, `${ORIGIN}/api/alerts/confirm`, { code: link_code });
    expect(again.status).toBe(303);
    expect(location(again)).toBe(`${ORIGIN}/alerts/confirm?code=${link_code}`);
  });

  it("goes back to the page for a code that is bad, expired or missing, and the page says so", async () => {
    const old = await createEmail();
    await pg.query(
      "update alert_subscriptions set created_at = now() - interval '25 hours' where id = $1",
      [old.id],
    );
    const cases: [Record<string, string>, string][] = [
      [{ code: old.link_code }, `${ORIGIN}/alerts/confirm?code=${old.link_code}`],
      [{ code: "0".repeat(32) }, `${ORIGIN}/alerts/confirm?code=${"0".repeat(32)}`],
      [{ code: "nope" }, `${ORIGIN}/alerts/confirm`],
      [{ code: "<script>" }, `${ORIGIN}/alerts/confirm`],
      [{}, `${ORIGIN}/alerts/confirm`],
    ];
    for (const [form, to] of cases) {
      const res = await post(confirmRoute, `${ORIGIN}/api/alerts/confirm`, form);
      expect(res.status, JSON.stringify(form)).toBe(303);
      expect(location(res), JSON.stringify(form)).toBe(to);
    }
    expect((await row(old.id))?.verified_at).toBeNull();
  });

  it("makes no database call for a code with a bad shape", async () => {
    const rpc = vi.fn();
    h.db = { rpc } as unknown as Db;
    await post(confirmRoute, `${ORIGIN}/api/alerts/confirm`, { code: "nope" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("changes nothing on a GET: it is a POST route only", () => {
    expect(Object.keys(confirmRoute).sort()).toEqual(["POST", "dynamic"]);
  });

  it("answers 429 when one address has asked too often, and confirms nothing", async () => {
    const { id, link_code } = await createEmail();
    await pg.query(
      "insert into rate_limits (bucket, window_start, count) values ('alerts:link:203.0.113.5', now(), 30)",
    );
    const res = await post(confirmRoute, `${ORIGIN}/api/alerts/confirm`, { code: link_code });
    expect(res.status).toBe(429);
    expect((await row(id))?.verified_at).toBeNull();
  });

  it("answers 503 when the database fails, and logs no code", async () => {
    const { link_code } = await createEmail();
    h.db = {
      rpc: async () => Promise.reject(new Error(`connection refused ${link_code}`)),
    } as unknown as Db;
    const res = await post(confirmRoute, `${ORIGIN}/api/alerts/confirm`, { code: link_code });
    expect(res.status).toBe(503);
    expect(logs.lines.join("\n")).not.toContain(link_code);
  });
});

describe("/alerts/stop", () => {
  const link = async (id: string) => {
    const q = new URL((await stopLinks(ORIGIN, await deriveSubkey(MASTER, "alerts"), id)).page)
      .searchParams;
    return { s: q.get("s") as string, t: q.get("t") as string };
  };

  it("is not indexed", () => {
    expect(stopMetadata.robots).toEqual({ index: false, follow: false });
  });

  it("shows a button that POSTs to the stop route, and stops nothing by being opened", async () => {
    const { id } = await createEmail();
    const { s, t } = await link(id);
    const out = html(await stopPage({ s, t }));
    expect(out).toContain("Stop these alerts?");
    expect(out).toContain(`action="/api/alerts/stop?s=${s}&amp;t=${t}"`);
    expect(out).toMatch(/method="post"/);
    expect(out).toContain('name="from" value="page"');
    expect(await row(id)).toMatchObject({ active: true });
  });

  it("says the link is not valid for a missing, mistyped or forged one, and shows no button", async () => {
    const { id } = await createEmail();
    const { s, t } = await link(id);
    const other = (await createEmail()).id;
    const cases = [
      {},
      { s },
      { t },
      { s, t: "0".repeat(64) },
      { s, t: t.toUpperCase() },
      { s: other, t }, // the token of another subscription
      { s: "nope", t },
      { s: [s, s], t },
    ];
    for (const q of cases) {
      const out = html(await stopPage(q as Record<string, string>));
      expect(out, JSON.stringify(q)).toContain("This stop link is not valid.");
      expect(out, JSON.stringify(q)).not.toContain("<form");
    }
  });

  it("says the alerts are stopped once they are, for the one that was stopped and for one that never was", async () => {
    const { id } = await createEmail();
    const { s, t } = await link(id);
    expect(html(await stopPage({ s, t, done: "1" }))).toContain("Alerts stopped.");
    const ghost = "00000000-0000-4000-8000-000000000000";
    const gt = await stopToken(await deriveSubkey(MASTER, "alerts"), ghost);
    expect(html(await stopPage({ s: ghost, t: gt, done: "1" }))).toContain("Alerts stopped.");
    expect(html(await stopPage({ s, t: "0".repeat(64), done: "1" }))).toContain("not valid");
  });

  it("says it could not stop right now after a failed attempt", async () => {
    const { id } = await createEmail();
    const { s, t } = await link(id);
    const out = html(await stopPage({ s, t, failed: "1" }));
    expect(out).toContain("could not be stopped right now");
    expect(out).toContain("<form");
  });
});

describe("POST /api/alerts/stop", () => {
  const link = async (id: string) => {
    const links = await stopLinks(ORIGIN, await deriveSubkey(MASTER, "alerts"), id);
    return links;
  };

  it("stops the subscription from the one-click POST a mail client sends, and answers 200", async () => {
    const { id } = await createEmail();
    const { oneClick } = await link(id);
    const res = await post(stopRoute, oneClick, { "List-Unsubscribe": "One-Click" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await row(id)).toMatchObject({ active: false });
  });

  it("stops it from the page's button too, then sends the person back to the page that says so", async () => {
    const { id } = await createEmail();
    const { oneClick } = await link(id);
    const q = new URL(oneClick).search;
    const res = await post(stopRoute, oneClick, { from: "page" });
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${ORIGIN}/alerts/stop${q}&done=1`);
    expect(await row(id)).toMatchObject({ active: false });
  });

  it("answers the same whether or not the subscription existed, and whether or not it was already off", async () => {
    const { id } = await createEmail();
    const real = await link(id);
    const ghost = await link("00000000-0000-4000-8000-000000000000");
    for (const url of [real.oneClick, real.oneClick, ghost.oneClick]) {
      const res = await post(stopRoute, url);
      expect(res.status, url).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
  });

  it("answers 400 and touches no subscription for a token that is wrong, short, upper-cased or another id's", async () => {
    const a = await createEmail();
    const b = await createEmail();
    const goodA = await link(a.id);
    const qA = new URL(goodA.oneClick).searchParams;
    const bad = [
      `${ORIGIN}/api/alerts/stop?s=${a.id}&t=${"0".repeat(64)}`,
      `${ORIGIN}/api/alerts/stop?s=${a.id}&t=${qA.get("t")?.slice(1)}`,
      `${ORIGIN}/api/alerts/stop?s=${a.id}&t=${qA.get("t")?.toUpperCase()}`,
      `${ORIGIN}/api/alerts/stop?s=${b.id}&t=${qA.get("t")}`,
      `${ORIGIN}/api/alerts/stop?s=nope&t=${qA.get("t")}`,
      `${ORIGIN}/api/alerts/stop?s=${a.id}`,
      `${ORIGIN}/api/alerts/stop`,
    ];
    for (const url of bad) {
      const res = await post(stopRoute, url);
      expect(res.status, url).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_link" });
    }
    expect(await row(a.id)).toMatchObject({ active: true });
    expect(await row(b.id)).toMatchObject({ active: true });
  });

  it("makes no database call for a link that is not valid", async () => {
    const rpc = vi.fn();
    h.db = { rpc } as unknown as Db;
    await post(stopRoute, `${ORIGIN}/api/alerts/stop?s=nope&t=nope`);
    await post(
      stopRoute,
      `${ORIGIN}/api/alerts/stop?s=00000000-0000-4000-8000-000000000000&t=${"0".repeat(64)}`,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("is a POST route only, so opening the link in a mail scanner stops nothing", () => {
    expect(Object.keys(stopRoute).sort()).toEqual(["POST", "dynamic"]);
  });

  it("answers 503 when the database fails, and the page's button goes back to a page that says so", async () => {
    const { id } = await createEmail();
    const { oneClick } = await link(id);
    const q = new URL(oneClick).search;
    h.db = { rpc: async () => Promise.reject(new Error("connection refused")) } as unknown as Db;
    expect((await post(stopRoute, oneClick)).status).toBe(503);
    const res = await post(stopRoute, oneClick, { from: "page" });
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${ORIGIN}/alerts/stop${q}&failed=1`);
  });

  it("has no rate limit to turn an unsubscribe away: a valid token is all it asks for", async () => {
    const { id } = await createEmail();
    const { oneClick } = await link(id);
    await pg.query(
      "insert into rate_limits (bucket, window_start, count) values ('alerts:link:203.0.113.5', now(), 9999)",
    );
    expect((await post(stopRoute, oneClick)).status).toBe(200);
  });
});

describe("the two public pages stay out of the sitemap and the robots file's way", () => {
  it("are not in the sitemap, which lists only the pages the site's menus link to", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const paths = sitemap().map((e) => new URL(e.url).pathname);
    expect(paths.filter((p) => p.startsWith("/alerts") || p.startsWith("/api"))).toEqual([]);
  });
});
