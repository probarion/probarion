import type { PGlite } from "@electric-sql/pglite";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { freshDb, seedTenant } from "../../../../../test/db/harness";
import { pgliteDb } from "../../../../../test/db/pglite-db";
import { quietLogs } from "../../../../../test/fixtures/quiet-logs";

// The Alerts tab of a vault's console: who may see it, who may add and remove, and what the actions refuse. The
// database is PGlite (the real SQL answers); the session, the key, the settings and the two providers are replaced.
const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  db: null as unknown as Db,
  token: "123456789:AAH-test-token" as string | null,
  botUsername: vi.fn(),
  sendEmail: vi.fn(),
  email: true,
  revalidate: vi.fn(),
}));

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name) } : undefined),
  }),
  headers: async () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/lib/crypto/server", () => ({
  subkey: (purpose: Parameters<typeof deriveSubkey>[1]) => deriveSubkey(MASTER, purpose),
}));
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => h.db }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ NEAR_NETWORK: "mainnet", TELEGRAM_BOT_TOKEN: h.token }),
}));
vi.mock("@/lib/alerts/server", () => ({
  alertSenders: () => ({
    telegram: h.token ? async () => ({ ok: true, id: "1" }) : null,
    email: h.email ? { send: h.sendEmail } : null,
  }),
}));
vi.mock("@/lib/alerts/telegram", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/alerts/telegram")>()),
  telegramBotUsername: h.botUsername,
}));

import { addEmailAction, connectTelegramAction, removeSubscriptionAction } from "./actions";
import AlertsPage, { metadata } from "./page";

const logs = quietLogs();

const V = "acme.vaults.probarion.near";
const OTHER = "other.vaults.probarion.near";
const ORIGIN = "https://probarion.xyz";

let pg: PGlite;
let tenant: string;
let otherTenant: string;

beforeAll(async () => {
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "probarion.xyz");
  pg = await freshDb();
  h.db = pgliteDb(pg);
  // acme.near owns V, cfo.near approves it, view.near only views it; mallory.near owns OTHER only.
  tenant = await seedTenant(pg, { vault: V, owner: "acme.near", approvers: ["cfo.near"] });
  await pg.query(
    "insert into public.tenant_members (tenant_id, account_id, role) values ($1, 'view.near', 'viewer')",
    [tenant],
  );
  otherTenant = await seedTenant(pg, { vault: OTHER, owner: "mallory.near" });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});
beforeEach(async () => {
  await pg.exec("delete from alert_subscriptions; delete from rate_limits;");
  h.db = pgliteDb(pg);
  h.jar.clear();
  h.token = "123456789:AAH-test-token";
  h.email = true;
  h.botUsername.mockReset();
  h.botUsername.mockResolvedValue("ProbarionBot");
  h.sendEmail.mockReset();
  h.sendEmail.mockResolvedValue({ ok: true, id: "em_1" });
  h.revalidate.mockReset();
});

async function signInAs(account: string) {
  h.jar.set(
    SESSION_COOKIE,
    await createSessionToken(await deriveSubkey(MASTER, "session"), account),
  );
}
async function digest(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as { digest?: unknown }).digest ?? e);
  }
  return "no throw";
}
const page = (vault: string, searchParams: { verified?: string } = {}) =>
  AlertsPage({ params: Promise.resolve({ vault }), searchParams: Promise.resolve(searchParams) });
const html = async (vault = V, searchParams: { verified?: string } = {}) =>
  renderToStaticMarkup((await page(vault, searchParams)) as ReactElement).replaceAll("&#x27;", "'");

type Created = { id: string; link_code: string };
const create = (over: Record<string, unknown> = {}, t = tenant) =>
  h.db.rpc<Created>("alert_subscription_create", {
    tenant_id: t,
    channel: "email",
    target: "owner@example.com",
    created_by: "acme.near",
    ...over,
  });
const confirmed = async (over: Record<string, unknown> = {}, t = tenant) => {
  const c = await create(over, t);
  const isTelegram = over.channel === "telegram";
  await h.db.rpc("alert_subscription_verify", {
    channel: isTelegram ? "telegram" : "email",
    link_code: c.link_code,
    ...(isTelegram ? { target: "424242" } : {}),
  });
  return c;
};
const subs = async () =>
  (
    await pg.query<{
      id: string;
      channel: string;
      target: string | null;
      active: boolean;
      tenant_id: string;
      link_code: string | null;
    }>(
      "select id, channel, target, active, tenant_id, link_code from alert_subscriptions order by created_at",
    )
  ).rows;
/** The database as it is, except that the named functions fail (the membership lookup must still answer). */
const failing = (...names: string[]): Db => ({
  rpc: (fn: string, p?: Record<string, unknown>) =>
    names.includes(fn)
      ? Promise.reject(new Error("connection refused at 10.0.0.1"))
      : pgliteDb(pg).rpc(fn, p),
});
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("the alerts page", () => {
  it("has the title Alerts", () => {
    expect(metadata).toEqual({ title: "Alerts" });
  });

  it("sends a signed-out visitor to /login", async () => {
    expect(await digest(page(V))).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login/);
  });

  it("is a 404 for a non-member, for a vault that does not exist, and for text that is no vault id", async () => {
    await signInAs("mallory.near");
    expect(await digest(page(V))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(await digest(page("nope.vaults.probarion.near"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(await digest(page("Not A Vault"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("shows an owner the vault id, the role, the tabs with Alerts, the notice and the two add cards", async () => {
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain(`<h1 class="mono mb-1 text-2xl font-semibold break-all">${V}</h1>`);
    expect(out).toContain("Alerts · you are owner");
    expect(out).toContain(`href="/console/${V}/alerts"`);
    expect(out).toContain(">Alerts</a>");
    expect(out).toContain("Active alerts");
    expect(out).toContain("Add email");
    expect(out).toContain("Add Telegram");
    expect(out).toContain("Send confirmation");
    expect(out).toContain("Create a Telegram link");
  });

  it("tells the truth about when a message arrives: the watcher's checks, never an unconditional minute", async () => {
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain(
      "right after an invoice upload, once a day, and every minute once its schedule is on",
    );
    expect(out).toContain("a change made only on the chain can wait for the next check");
    expect(out).not.toMatch(/within (about )?a minute/i);
  });

  it("says there are no alerts yet when there are none, and lists none", async () => {
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("No alerts yet");
    expect(out).not.toContain("Remove");
  });

  it("lists each alert with its channel, its target, whether it is on, and a Remove button, then says the kinds in plain words", async () => {
    await confirmed({ target: "finance@example.com" });
    await confirmed({ channel: "telegram" });
    await create({ target: "later@example.com" }); // not confirmed yet
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("finance@example.com");
    expect(out).toContain("later@example.com");
    expect(out).toContain(">email</span>");
    expect(out).toContain(">Telegram</span>");
    expect((out.match(/>on<\/span>/g) ?? []).length).toBe(2);
    expect(out).toContain(">waiting for confirmation</span>");
    expect((out.match(/>Remove<\/button>/g) ?? []).length).toBe(3);
    expect(out).toContain(
      "a spend waits for approval, the contract refuses a spend, a spend is paid",
    );
    expect(out).toContain("the vault's free NEAR runs low");
    expect(out).not.toMatch(/spend_held|refused_by_contract|near_low/);
    expect(out).toContain("mono"); // the target in mono
  });

  it("shows a Telegram alert that is not linked yet as such, with no chat id to show", async () => {
    await create({ channel: "telegram", target: undefined });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("Telegram link not used yet");
    expect(out).toContain(">waiting for confirmation</span>");
  });

  it("never puts a link code in the page", async () => {
    const a = await create({ target: "a@example.com" });
    const b = await create({ channel: "telegram", target: undefined });
    await signInAs("acme.near");
    const out = await html();
    expect(out).not.toContain(a.link_code);
    expect(out).not.toContain(b.link_code);
  });

  it("shows only this vault's alerts", async () => {
    await confirmed({ target: "mine@example.com" });
    await confirmed({ target: "theirs@example.com" }, otherTenant);
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("mine@example.com");
    expect(out).not.toContain("theirs@example.com");
  });

  it("says the alerts could not be read, never that there are none, when the list fails", async () => {
    await signInAs("acme.near");
    h.db = failing("alert_subscriptions_list");
    const out = await html();
    expect(out).toContain("The alerts could not be read right now. Try again in a minute.");
    expect(out).not.toContain("No alerts yet");
    expect(out).not.toContain("connection refused");
    expect(out).toContain("Send confirmation"); // the rest of the page still works
  });

  it("shows an approver the same page and the same controls", async () => {
    await confirmed({ target: "finance@example.com" });
    await signInAs("cfo.near");
    const out = await html();
    expect(out).toContain("Alerts · you are approver");
    expect(out).toContain("Send confirmation");
    expect(out).toContain("Create a Telegram link");
    expect(out).toContain(">Remove</button>");
  });

  it("shows a viewer the list and no way to change it, and says why", async () => {
    await confirmed({ target: "finance@example.com" });
    await signInAs("view.near");
    const out = await html();
    expect(out).toContain("Alerts · you are viewer");
    expect(out).toContain("finance@example.com");
    expect(out).toContain("Only the vault's owners and approvers can add or remove alerts.");
    expect(out).not.toContain("Send confirmation");
    expect(out).not.toContain("Create a Telegram link");
    expect(out).not.toContain(">Remove</button>");
    expect(out).not.toContain("<form");
  });

  it("confirms an address that was just confirmed, and not otherwise", async () => {
    await signInAs("acme.near");
    expect(await html(V, { verified: "1" })).toContain("Email confirmed. Alerts are on.");
    expect(await html(V, {})).not.toContain("Email confirmed");
    expect(await html(V, { verified: "yes" })).not.toContain("Email confirmed");
  });

  it("hints how long each link works and how to stop", async () => {
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("The link in it works for 24 hours");
    expect(out).toContain("every alert email has a stop link that needs no sign-in");
    expect(out).toContain("The link works once, for 24 hours");
    expect(out).toContain("/stop");
  });

  it("escapes what it shows: an address with markup is text", async () => {
    await pg.query(
      "insert into alert_subscriptions (tenant_id, channel, target, kinds, verified_at, created_by) values ($1, 'email', 'a<b>@example.com', array['spend_paid'], now(), 'x')",
      [tenant],
    );
    await signInAs("acme.near");
    const out = await html();
    expect(out).not.toContain("<b>@");
  });
});

describe("addEmailAction", () => {
  const add = (email: string, vault = V) => addEmailAction(vault, null, form({ email }));

  it("makes an unconfirmed subscription, emails the confirmation link, and says so", async () => {
    await signInAs("acme.near");
    const r = await add("  Finance@Example.com ");
    expect(r).toEqual({
      ok: true,
      message: "Confirmation sent to finance@example.com. Open the link in it within 24 hours.",
    });
    const [row] = await subs();
    expect(row).toMatchObject({
      channel: "email",
      target: "finance@example.com",
      tenant_id: tenant,
      active: true,
    });
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    const sent = h.sendEmail.mock.calls[0]?.[0] as Record<string, string>;
    expect(sent.to).toBe("finance@example.com");
    expect(sent.subject).toBe(`[Probarion] Confirm alerts for ${V}`);
    expect(sent.text).toContain(V);
    expect(sent.text).toContain(`${ORIGIN}/alerts/confirm?code=${row?.link_code}`);
    expect(sent.text).toContain("works once and for 24 hours");
    expect(sent.text).toContain("If you did not ask for this, ignore this email");
    expect(sent.idempotencyKey).toBe(`verify-${row?.link_code}`);
    expect(sent.text).not.toContain("/api/alerts/verify-email");
    expect(h.revalidate).toHaveBeenCalledWith(`/console/${V}/alerts`);
  });

  it("is open to an approver, and to nobody else: a viewer, a stranger and a signed-out caller change nothing", async () => {
    await signInAs("cfo.near");
    expect(await add("a@example.com")).toMatchObject({ ok: true });
    for (const who of ["view.near", "mallory.near"]) {
      await signInAs(who);
      const r = await add("b@example.com");
      expect(r, who).toMatchObject({ ok: false, status: 403 });
    }
    h.jar.clear();
    expect(await add("c@example.com")).toMatchObject({ ok: false, status: 401 });
    expect(await subs()).toHaveLength(1);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("uses the tenant of the membership row, whatever vault the form names", async () => {
    await signInAs("mallory.near"); // owns OTHER only
    expect(await add("x@example.com", V)).toMatchObject({ ok: false, status: 403 });
    expect(await add("x@example.com", OTHER)).toMatchObject({ ok: true });
    expect((await subs()).map((s) => s.tenant_id)).toEqual([otherTenant]);
  });

  it("refuses what is not an address, or is too long, before it touches the database or the mail", async () => {
    await signInAs("acme.near");
    for (const email of [
      "",
      "nope",
      "a@b",
      "a b@example.com",
      `${"a".repeat(250)}@example.com`,
      "a@@b.co",
    ]) {
      const r = await add(email);
      expect(r, email).toEqual({ ok: false, error: "That does not look like an email address." });
    }
    expect(await subs()).toHaveLength(0);
    expect(h.sendEmail).not.toHaveBeenCalled();
    // a missing field is the same refusal
    expect(await addEmailAction(V, null, new FormData())).toMatchObject({ ok: false });
  });

  it("says plainly when this server has no email provider, and makes no subscription", async () => {
    h.email = false;
    await signInAs("acme.near");
    expect(await add("a@example.com")).toEqual({
      ok: false,
      error: "Email alerts are not set up on this server.",
    });
    expect(await subs()).toHaveLength(0);
  });

  it("limits the confirmation emails per vault: the sixth in ten minutes is refused, and the others are not touched", async () => {
    await signInAs("acme.near");
    for (let i = 0; i < 5; i++) expect(await add(`a${i}@example.com`)).toMatchObject({ ok: true });
    const r = await add("a5@example.com");
    expect(r).toEqual({
      ok: false,
      error: "Too many confirmation emails for this vault. Try again in a few minutes.",
    });
    expect(h.sendEmail).toHaveBeenCalledTimes(5);
    expect(await subs()).toHaveLength(5);
  });

  it("switches the subscription off again when the confirmation cannot be sent, and says so without the provider's words", async () => {
    h.sendEmail.mockResolvedValue({
      ok: false,
      error: "domain probarion.xyz is not verified: secret detail",
    });
    await signInAs("acme.near");
    const r = await add("a@example.com");
    expect(r).toEqual({
      ok: false,
      error: "The confirmation email could not be sent. Try again in a few minutes.",
    });
    expect((await subs()).every((s) => !s.active)).toBe(true);
    expect(JSON.stringify(r)).not.toContain("secret detail");
    const line = logs.lines.find((l) => l.includes("alerts.confirmation_failed"));
    expect(line).toBeDefined();
    expect(line).not.toContain("a@example.com");
  });

  it("answers a sentence, never the exception, when the database fails or the mail provider throws", async () => {
    await signInAs("acme.near");
    h.sendEmail.mockRejectedValue(new Error("socket hang up: owner@example.com"));
    const thrown = await add("a@example.com");
    expect(thrown).toMatchObject({ ok: false });
    expect(JSON.stringify(thrown)).not.toContain("socket hang up");
    h.db = failing("alert_subscription_create");
    const failed = await add("b@example.com");
    expect(failed).toEqual({
      ok: false,
      error: "The alert could not be added. Try again in a minute.",
    });
    expect(JSON.stringify(failed)).not.toContain("connection refused");
    h.db = failing("rate_limit_take");
    expect(await add("c@example.com")).toMatchObject({ ok: false });
  });

  it("stops at 20 alerts on a vault and says to remove one", async () => {
    await signInAs("acme.near");
    for (let i = 0; i < 20; i++) await create({ target: `x${i}@example.com` });
    await pg.exec("delete from rate_limits;");
    expect(await add("late@example.com")).toEqual({
      ok: false,
      error: "This vault already has 20 alerts. Remove one first.",
    });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});

describe("connectTelegramAction", () => {
  it("makes an unlinked subscription and answers the t.me link with its code", async () => {
    await signInAs("acme.near");
    const r = await connectTelegramAction(V);
    const [row] = await subs();
    expect(row).toMatchObject({ channel: "telegram", target: null, tenant_id: tenant });
    expect(r).toEqual({ ok: true, link: `https://t.me/ProbarionBot?start=${row?.link_code}` });
    expect(h.revalidate).toHaveBeenCalledWith(`/console/${V}/alerts`);
  });

  it("is for an owner or an approver only", async () => {
    await signInAs("cfo.near");
    expect((await connectTelegramAction(V)).ok).toBe(true);
    for (const who of ["view.near", "mallory.near"]) {
      await signInAs(who);
      expect(await connectTelegramAction(V), who).toMatchObject({ ok: false, status: 403 });
    }
    h.jar.clear();
    expect(await connectTelegramAction(V)).toMatchObject({ ok: false, status: 401 });
    expect(await subs()).toHaveLength(1);
  });

  it("says plainly when this server has no bot, and when the bot's name cannot be read, and makes nothing", async () => {
    await signInAs("acme.near");
    h.token = null;
    expect(await connectTelegramAction(V)).toEqual({
      ok: false,
      error: "Telegram alerts are not set up on this server.",
    });
    h.token = "123456789:AAH-test-token";
    h.botUsername.mockResolvedValue(null);
    expect(await connectTelegramAction(V)).toEqual({
      ok: false,
      error: "Telegram alerts are not set up on this server.",
    });
    expect(await subs()).toHaveLength(0);
  });

  it("will not build a link from a bot name that is not a Telegram username", async () => {
    await signInAs("acme.near");
    h.botUsername.mockResolvedValue("evil/../bot?x=1");
    expect(await connectTelegramAction(V)).toMatchObject({ ok: false });
    expect(await subs()).toHaveLength(0);
  });

  it("is limited like the email action, and the two share the vault's budget", async () => {
    await signInAs("acme.near");
    for (let i = 0; i < 3; i++) await connectTelegramAction(V);
    for (let i = 0; i < 2; i++) await addEmailAction(V, null, form({ email: `a${i}@example.com` }));
    expect(await connectTelegramAction(V)).toEqual({
      ok: false,
      error: "Too many links for this vault. Try again in a few minutes.",
    });
    expect(await subs()).toHaveLength(5);
  });

  it("answers a sentence when the database fails", async () => {
    await signInAs("acme.near");
    h.db = failing("alert_subscription_create");
    const r = await connectTelegramAction(V);
    expect(r).toEqual({ ok: false, error: "The alert could not be added. Try again in a minute." });
    expect(JSON.stringify(r)).not.toContain("connection refused");
  });
});

describe("removeSubscriptionAction", () => {
  it("switches an alert off, inside the member's own vault only, and refreshes the page", async () => {
    const mine = await confirmed({ target: "mine@example.com" });
    const theirs = await confirmed({ target: "theirs@example.com" }, otherTenant);
    await signInAs("acme.near");
    await removeSubscriptionAction(V, theirs.id);
    expect((await subs()).find((s) => s.id === theirs.id)?.active).toBe(true); // not this vault's
    await removeSubscriptionAction(V, mine.id);
    expect((await subs()).find((s) => s.id === mine.id)?.active).toBe(false);
    expect(h.revalidate).toHaveBeenCalledWith(`/console/${V}/alerts`);
  });

  it("is for an owner or an approver: a viewer, a stranger and a signed-out caller remove nothing", async () => {
    const a = await confirmed({ target: "a@example.com" });
    for (const who of ["view.near", "mallory.near"]) {
      await signInAs(who);
      await removeSubscriptionAction(V, a.id);
    }
    h.jar.clear();
    await removeSubscriptionAction(V, a.id);
    expect((await subs()).find((s) => s.id === a.id)?.active).toBe(true);
    await signInAs("cfo.near");
    await removeSubscriptionAction(V, a.id);
    expect((await subs()).find((s) => s.id === a.id)?.active).toBe(false);
  });

  it("checks the id is a UUID before any database call", async () => {
    await signInAs("acme.near");
    const rpc = vi.fn(h.db.rpc);
    h.db = { rpc } as unknown as Db;
    for (const id of [
      "nope",
      "",
      "1; drop table alert_subscriptions",
      "../x",
      "00000000-0000-0000-0000-00000000000",
    ]) {
      await removeSubscriptionAction(V, id);
    }
    expect(rpc.mock.calls.filter(([fn]) => fn === "alert_subscription_deactivate")).toEqual([]);
  });

  it("does not throw, nor show the exception, when the database fails", async () => {
    await signInAs("acme.near");
    h.db = failing("alert_subscription_deactivate");
    await expect(
      removeSubscriptionAction(V, "00000000-0000-4000-8000-000000000000"),
    ).resolves.toBeUndefined();
    expect(logs.lines.join("\n")).toContain("alerts.remove_failed");
  });
});
