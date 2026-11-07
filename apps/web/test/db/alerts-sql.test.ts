import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDb, SUPABASE_STUB, seedTenant } from "./harness";
import { at } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

const V = "acme.vaults.probarion.near";
const OWNER = "acme.near";
const CHAT = "424242";
const OTHER_CHAT = "-100777";

/** The alert functions of migration 0011 (every one is service_role only), and the two of 0010 it redefines. */
const ALERT_FUNCTIONS = [
  "alert_subscription_create",
  "alert_subscription_verify",
  "alert_link_peek",
  "alert_subscriptions_list",
  "alert_subscription_deactivate",
  "alert_subscription_stop",
  "alert_telegram_stop",
  "alerts_pending",
  "alert_claim",
  "alert_mark",
] as const;
const REDEFINED = ["vault_event_insert", "tenant_watch_cursor_set"] as const;

describe("the alerts SQL", () => {
  let pg: PGlite;
  let tenant: string;

  beforeAll(async () => {
    pg = await freshDb();
    tenant = await seedTenant(pg, { vault: V, owner: OWNER });
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await pg.exec("delete from vault_events; delete from alert_subscriptions;");
    await pg.exec(`delete from tenants where vault_id <> '${V}';`);
    await pg.query("update tenants set watch_caught_up_at = null where id = $1", [tenant]);
  });

  const db = () => pgliteDb(pg);
  type Created = { id: string; link_code: string };
  const create = (over: Record<string, unknown> = {}) =>
    db().rpc<Created>("alert_subscription_create", {
      tenant_id: tenant,
      channel: "telegram",
      created_by: OWNER,
      ...over,
    });
  const verify = (over: Record<string, unknown>) =>
    db().rpc<{ tenant_id: string; vault_id: string; kinds: string[]; duplicate: boolean } | null>(
      "alert_subscription_verify",
      { channel: "telegram", target: CHAT, ...over },
    );
  const row = async (id: string) =>
    at(
      (
        await pg.query<{
          channel: string;
          target: string | null;
          link_code: string | null;
          kinds: string[];
          verified_at: string | null;
          active: boolean;
        }>(
          "select channel, target, link_code, kinds, verified_at, active from alert_subscriptions where id = $1",
          [id],
        )
      ).rows,
    );

  describe("alert_subscription_create", () => {
    it("makes a Telegram subscription with a one-use link code of 32 hex characters and no target yet", async () => {
      const { id, link_code } = await create();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(link_code).toMatch(/^[0-9a-f]{32}$/);
      expect(await row(id)).toMatchObject({
        channel: "telegram",
        target: null,
        verified_at: null,
        active: true,
      });
      expect((await create()).link_code).not.toBe(link_code);
    });

    it("takes the kinds from the table's default, near_low included, so the list is written once (R3)", async () => {
      const { id } = await create();
      const direct = await pg.query<{ kinds: string[] }>(
        "insert into alert_subscriptions (tenant_id, channel, created_by) values ($1, 'telegram', 'x') returning kinds",
        [tenant],
      );
      expect((await row(id)).kinds).toEqual(at(direct.rows).kinds);
      expect((await row(id)).kinds).toContain("near_low");
    });

    it("takes a given array of kinds, and ignores anything that is not an array", async () => {
      expect((await row((await create({ kinds: ["spend_held", "near_low"] })).id)).kinds).toEqual([
        "spend_held",
        "near_low",
      ]);
      const dflt = (await row((await create()).id)).kinds;
      for (const kinds of ["spend_held", 5, null, { a: 1 }]) {
        expect((await row((await create({ kinds })).id)).kinds, String(kinds)).toEqual(dflt);
      }
    });

    it("refuses a kind the vault_events check does not know, an empty list and a list with a non-text entry", async () => {
      for (const kinds of [
        ["spend_teleported"],
        ["spend_held", "nope"],
        [],
        [1],
        [null],
        [["spend_held"]],
      ]) {
        await expect(create({ kinds }), JSON.stringify(kinds)).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
    });

    it("accepts every kind the vault_events check accepts, so the two lists cannot drift apart", async () => {
      const def = await pg.query<{ def: string }>(
        `select pg_get_constraintdef(c.oid) as def from pg_constraint c
          where c.conrelid = 'public.vault_events'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%spend_held%'`,
      );
      const kinds = [...at(def.rows).def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
      expect(kinds.length).toBeGreaterThanOrEqual(12);
      expect(kinds).toContain("near_low");
      const { id } = await create({ kinds });
      expect((await row(id)).kinds.sort()).toEqual([...kinds].sort());
    });

    it("makes an email subscription with its address lower-cased and trimmed", async () => {
      const { id } = await create({ channel: "email", target: "  Finance@Example.COM " });
      expect(await row(id)).toMatchObject({
        channel: "email",
        target: "finance@example.com",
        verified_at: null,
      });
    });

    it("takes an address with the usual local-part characters, a plus tag and a subdomain", async () => {
      for (const target of [
        "a.b+tag@mail.example.co.uk",
        "first_last-1@x-y.example.com",
        "a!b#c@example.io",
      ]) {
        expect((await row((await create({ channel: "email", target })).id)).target, target).toBe(
          target,
        );
      }
    });

    it("keeps no target for a Telegram subscription, whatever was sent", async () => {
      const { id } = await create({ target: "someone@example.com" });
      expect((await row(id)).target).toBeNull();
    });

    it("refuses what is not a subscription: bad channel, bad or missing address, no creator, bad tenant", async () => {
      const bad: Record<string, unknown>[] = [
        { channel: "sms" },
        { channel: null },
        { channel: "email" },
        { channel: "email", target: "" },
        { channel: "email", target: "not an address" },
        { channel: "email", target: "a@b" },
        { channel: "email", target: `${"a".repeat(250)}@example.com` },
        { channel: "email", target: "a b@example.com" },
        // one address and only one: nothing a mailer reads as a list, a display name or a comment
        { channel: "email", target: "a@b.co,victim@x.co" },
        { channel: "email", target: "a@b.co;victim@x.co" },
        { channel: "email", target: "<a@b.co>" },
        { channel: "email", target: "Name <a@b.co>" },
        { channel: "email", target: '"a"@b.co' },
        { channel: "email", target: "a(c)@b.co" },
        { channel: "email", target: "a\\b@c.co" },
        { channel: "email", target: "a\u0007@b.co" }, // a NUL cannot get here: jsonb refuses it first
        { channel: "email", target: "a@b@c.co" },
        { channel: "email", target: "@b.co" },
        { channel: "email", target: "a@.co" },
        { channel: "email", target: "a@b..co" },
        { channel: "email", target: "a@b.co." },
        { channel: "email", target: "a@-b.co" },
        { channel: "email", target: "a@b_c.co" },
        { channel: "email", target: "a@b.c o" },
        { channel: "email", target: "a@b.co\nx@y.zz" },
        { channel: "email", target: `${"a".repeat(65)}@example.com` },
        { channel: "email", target: "\u00e9@example.com" },
        { created_by: "" },
        { created_by: null },
        { tenant_id: "nope" },
        { tenant_id: null },
      ];
      for (const over of bad) {
        await expect(create(over), JSON.stringify(over)).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
      await expect(
        create({ tenant_id: "00000000-0000-4000-8000-000000000000" }),
      ).rejects.toBeDefined();
    });

    it("keeps at most 20 active subscriptions on a vault, and a removed one does not count", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) ids.push((await create()).id);
      await expect(create()).rejects.toMatchObject({ code: "limit_reached" });
      await db().rpc("alert_subscription_deactivate", { tenant_id: tenant, id: at(ids) });
      await expect(create()).resolves.toBeDefined();
    });

    it("drops this vault's unconfirmed subscriptions whose link has expired, and nobody else's", async () => {
      const old = await create();
      const confirmed = await create();
      await verify({ link_code: confirmed.link_code });
      const other = await seedTenant(pg, {
        vault: "other.vaults.probarion.near",
        owner: "other.near",
      });
      const othersOld = await create({ tenant_id: other });
      await pg.query("update alert_subscriptions set created_at = now() - interval '25 hours'");
      await create();
      const left = await pg.query<{ id: string }>("select id from alert_subscriptions");
      const ids = left.rows.map((r) => r.id);
      expect(ids).not.toContain(old.id);
      expect(ids).toContain(confirmed.id);
      expect(ids).toContain(othersOld.id);
    });
  });

  describe("alert_subscription_verify", () => {
    it("links the chat, clears the code so it works once, and says which vault and which kinds", async () => {
      const { id, link_code } = await create();
      const r = await verify({ link_code });
      expect(r).toMatchObject({ tenant_id: tenant, vault_id: V, duplicate: false });
      expect(r?.kinds).toContain("spend_held");
      expect(await row(id)).toMatchObject({ target: CHAT, link_code: null, active: true });
      expect((await row(id)).verified_at).not.toBeNull();
      expect(await verify({ link_code })).toBeNull(); // the same code again
    });

    it("confirms an email by its code, and keeps the address it was created with", async () => {
      const { id, link_code } = await create({ channel: "email", target: "Owner@Example.com" });
      const r = await verify({ channel: "email", link_code, target: "someone-else@example.com" });
      expect(r).toMatchObject({ vault_id: V });
      expect(await row(id)).toMatchObject({ target: "owner@example.com", link_code: null });
    });

    it("answers null for a code that is unknown, mistyped, for the other channel, expired or removed", async () => {
      const tg = await create();
      const email = await create({ channel: "email", target: "a@example.com" });
      expect(await verify({ link_code: "0".repeat(32) })).toBeNull();
      expect(await verify({ link_code: "nope" })).toBeNull();
      expect(await verify({ link_code: "" })).toBeNull();
      expect(await verify({ link_code: null })).toBeNull();
      expect(await verify({ link_code: email.link_code })).toBeNull(); // an email code on the Telegram channel
      expect(await verify({ channel: "email", link_code: tg.link_code })).toBeNull();
      const old = await create();
      await pg.query(
        "update alert_subscriptions set created_at = now() - interval '25 hours' where id = $1",
        [old.id],
      );
      expect(await verify({ link_code: old.link_code })).toBeNull();
      const gone = await create();
      await db().rpc("alert_subscription_deactivate", { tenant_id: tenant, id: gone.id });
      expect(await verify({ link_code: gone.link_code })).toBeNull();
      // none of those used up the real codes
      expect(await verify({ link_code: tg.link_code })).not.toBeNull();
    });

    it("accepts a code that is 23 hours old and refuses one that is 25", async () => {
      const a = await create();
      const b = await create();
      await pg.query(
        "update alert_subscriptions set created_at = now() - interval '23 hours' where id = $1",
        [a.id],
      );
      await pg.query(
        "update alert_subscriptions set created_at = now() - interval '25 hours' where id = $1",
        [b.id],
      );
      expect(await verify({ link_code: a.link_code })).not.toBeNull();
      expect(await verify({ link_code: b.link_code })).toBeNull();
    });

    it("refuses a Telegram link with no chat, or one that is not a chat id", async () => {
      const { link_code } = await create();
      for (const target of [null, "", "abc", "12 34", "1".repeat(30), "--5"]) {
        await expect(verify({ link_code, target }), String(target)).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
      expect(await verify({ link_code, target: "-100123" })).not.toBeNull(); // a group id is negative
    });

    it("refuses a channel that is not one", async () => {
      await expect(verify({ channel: "sms", link_code: "0".repeat(32) })).rejects.toMatchObject({
        code: "invalid_input",
      });
    });

    it("does not send alerts twice to a chat that is already linked: the second link is consumed and switched off", async () => {
      const first = await create();
      const second = await create();
      await verify({ link_code: first.link_code });
      const r = await verify({ link_code: second.link_code });
      expect(r).toMatchObject({ duplicate: true, vault_id: V });
      expect(await row(first.id)).toMatchObject({ active: true });
      expect(await row(second.id)).toMatchObject({ active: false, link_code: null });
      // another chat is not a duplicate
      const third = await create();
      expect(await verify({ link_code: third.link_code, target: OTHER_CHAT })).toMatchObject({
        duplicate: false,
      });
    });

    it("treats the same address on the same vault as one subscription too, but not on another vault", async () => {
      const a = await create({ channel: "email", target: "same@example.com" });
      const b = await create({ channel: "email", target: "SAME@example.com" });
      await verify({ channel: "email", link_code: a.link_code });
      expect(await verify({ channel: "email", link_code: b.link_code })).toMatchObject({
        duplicate: true,
      });
      const other = await seedTenant(pg, {
        vault: "other.vaults.probarion.near",
        owner: "other.near",
      });
      const c = await create({ tenant_id: other, channel: "email", target: "same@example.com" });
      expect(await verify({ channel: "email", link_code: c.link_code })).toMatchObject({
        duplicate: false,
      });
    });
  });

  describe("alert_link_peek", () => {
    it("names the vault a code is for without using the code up", async () => {
      const { link_code } = await create({ channel: "email", target: "a@example.com" });
      const peek = (code: unknown, channel = "email") =>
        db().rpc("alert_link_peek", { channel, link_code: code });
      expect(await peek(link_code)).toEqual({ vault_id: V });
      expect(await peek(link_code)).toEqual({ vault_id: V });
      expect(await verify({ channel: "email", link_code })).not.toBeNull();
      expect(await peek(link_code)).toBeNull(); // used
    });

    it("answers null for what verify would refuse", async () => {
      const old = await create({ channel: "email", target: "a@example.com" });
      await pg.query(
        "update alert_subscriptions set created_at = now() - interval '25 hours' where id = $1",
        [old.id],
      );
      const tg = await create();
      const peek = (code: unknown, channel = "email") =>
        db().rpc("alert_link_peek", { channel, link_code: code });
      expect(await peek(old.link_code)).toBeNull();
      expect(await peek(tg.link_code)).toBeNull(); // the other channel
      expect(await peek("nope")).toBeNull();
      expect(await peek(null)).toBeNull();
      expect(await peek("0".repeat(32))).toBeNull();
    });
  });

  describe("alert_subscriptions_list", () => {
    it("lists a vault's live subscriptions in order, with the address, and never a link code", async () => {
      const a = await create({ channel: "email", target: "a@example.com" });
      // Two inserts can share one timestamp, and the list then falls back to the random id.
      await pg.query(
        "update alert_subscriptions set created_at = now() - interval '1 minute' where id = $1",
        [a.id],
      );
      const b = await create();
      await verify({ link_code: b.link_code });
      const list = await db().rpc<Record<string, unknown>[]>("alert_subscriptions_list", {
        tenant_id: tenant,
        full: true,
      });
      expect(list.map((s) => s.id)).toEqual([a.id, b.id]);
      expect(list[0]).toMatchObject({
        channel: "email",
        target: "a@example.com",
        verified_at: null,
      });
      expect(list[1]).toMatchObject({ channel: "telegram", target: CHAT });
      expect(Object.keys(list[0] ?? {}).sort()).toEqual([
        "channel",
        "created_at",
        "id",
        "kinds",
        "target",
        "verified_at",
      ]);
      expect(JSON.stringify(list)).not.toContain(a.link_code);
    });

    it("masks every target unless it is asked for in full: an address to its first letter and domain, a chat to its last 2 digits", async () => {
      // Back to back, the three can share one timestamp, and the list would then order them by their random ids.
      const finance = await create({ channel: "email", target: "Finance@Example.com" });
      const x = await create({ channel: "email", target: "x@y.co" });
      for (const [id, minutes] of [
        [finance.id, 2],
        [x.id, 1],
      ] as const) {
        await pg.query(
          "update alert_subscriptions set created_at = now() - make_interval(mins => $2) where id = $1",
          [id, minutes],
        );
      }
      const tg = await create();
      await verify({ link_code: tg.link_code });
      const targets = async (p: Record<string, unknown>) =>
        (
          await db().rpc<{ target: string | null }[]>("alert_subscriptions_list", {
            tenant_id: tenant,
            ...p,
          })
        ).map((s) => s.target);
      const dots = "\u2022";
      for (const p of [{}, { full: false }, { full: "yes" }, { full: 1 }]) {
        expect(await targets(p), JSON.stringify(p)).toEqual([
          `f${dots.repeat(3)}@example.com`,
          `x${dots.repeat(3)}@y.co`,
          `${dots.repeat(4)}${CHAT.slice(-2)}`,
        ]);
      }
      expect(await targets({ full: true })).toEqual(["finance@example.com", "x@y.co", CHAT]);
    });

    it("leaves an unlinked Telegram target null, masked or not", async () => {
      await create();
      for (const p of [{}, { full: true }]) {
        const [s] = await db().rpc<{ target: string | null }[]>("alert_subscriptions_list", {
          tenant_id: tenant,
          ...p,
        });
        expect(s?.target).toBeNull();
      }
    });

    it("leaves out removed subscriptions, unconfirmed ones whose link expired, and other vaults'", async () => {
      const removed = await create();
      await db().rpc("alert_subscription_deactivate", { tenant_id: tenant, id: removed.id });
      const expired = await create({ channel: "email", target: "old@example.com" });
      await pg.query(
        "update alert_subscriptions set created_at = now() - interval '25 hours' where id = $1",
        [expired.id],
      );
      const confirmedOld = await create();
      await verify({ link_code: confirmedOld.link_code });
      await pg.query(
        "update alert_subscriptions set created_at = now() - interval '9 days' where id = $1",
        [confirmedOld.id],
      );
      const other = await seedTenant(pg, {
        vault: "other.vaults.probarion.near",
        owner: "other.near",
      });
      await create({ tenant_id: other });
      const list = await db().rpc<{ id: string }[]>("alert_subscriptions_list", {
        tenant_id: tenant,
      });
      expect(list.map((s) => s.id)).toEqual([confirmedOld.id]);
    });

    it("is an empty list for a vault with nothing, and refuses a tenant id that is not one", async () => {
      expect(await db().rpc("alert_subscriptions_list", { tenant_id: tenant })).toEqual([]);
      await expect(
        db().rpc("alert_subscriptions_list", { tenant_id: "nope" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  describe("stopping", () => {
    it("alert_subscription_deactivate switches one subscription off, only inside the tenant it is asked for", async () => {
      const mine = await create();
      const other = await seedTenant(pg, {
        vault: "other.vaults.probarion.near",
        owner: "other.near",
      });
      const theirs = await create({ tenant_id: other });
      expect(
        await db().rpc("alert_subscription_deactivate", { tenant_id: tenant, id: theirs.id }),
      ).toBeNull();
      expect((await row(theirs.id)).active).toBe(true);
      expect(
        await db().rpc("alert_subscription_deactivate", { tenant_id: tenant, id: mine.id }),
      ).toEqual({ id: mine.id });
      expect((await row(mine.id)).active).toBe(false);
      await expect(
        db().rpc("alert_subscription_deactivate", { tenant_id: tenant, id: "nope" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        db().rpc("alert_subscription_deactivate", { tenant_id: "nope", id: mine.id }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("alert_subscription_stop switches one off by its id alone (the email's stop link), and says nothing more", async () => {
      const a = await create({ channel: "email", target: "a@example.com" });
      const b = await create({ channel: "email", target: "b@example.com" });
      expect(await db().rpc("alert_subscription_stop", { id: a.id })).toEqual({ stopped: true });
      expect((await row(a.id)).active).toBe(false);
      expect((await row(b.id)).active).toBe(true);
      // the same answer for one that is already off and for one that never existed
      expect(await db().rpc("alert_subscription_stop", { id: a.id })).toEqual({ stopped: true });
      expect(
        await db().rpc("alert_subscription_stop", { id: "00000000-0000-4000-8000-000000000000" }),
      ).toEqual({ stopped: true });
      await expect(db().rpc("alert_subscription_stop", { id: "nope" })).rejects.toMatchObject({
        code: "invalid_input",
      });
    });

    it("alert_telegram_stop switches off every Telegram subscription of a chat and counts the vaults", async () => {
      const other = await seedTenant(pg, {
        vault: "other.vaults.probarion.near",
        owner: "other.near",
      });
      const link = async (tenantId: string, chat: string) => {
        const { id, link_code } = await create({ tenant_id: tenantId });
        await verify({ link_code, target: chat });
        return id;
      };
      const a = await link(tenant, CHAT);
      const b = await link(other, CHAT);
      const c = await link(tenant, OTHER_CHAT);
      const email = await create({ channel: "email", target: "a@example.com" });
      expect(await db().rpc("alert_telegram_stop", { chat_id: CHAT })).toEqual({ stopped: 2 });
      expect((await row(a)).active).toBe(false);
      expect((await row(b)).active).toBe(false);
      expect((await row(c)).active).toBe(true);
      expect((await row(email.id)).active).toBe(true);
      expect(await db().rpc("alert_telegram_stop", { chat_id: CHAT })).toEqual({ stopped: 0 });
      await expect(db().rpc("alert_telegram_stop", { chat_id: "x" })).rejects.toMatchObject({
        code: "invalid_input",
      });
    });
  });

  describe("claiming and marking", () => {
    async function pending() {
      const { id, link_code } = await create();
      await verify({ link_code });
      const e = await pg.query<{ id: string }>(
        "insert into vault_events (tenant_id, event_key, kind, observed_at) values ($1, 'spend:1:held', 'spend_held', now() + interval '1 second') returning id",
        [tenant],
      );
      return { sub: id, event: Number(at(e.rows).id) };
    }
    const claim = (sub: string, event: number) =>
      db().rpc<{ claimed: boolean; id: number | null; attempt: number | null }>("alert_claim", {
        subscription_id: sub,
        vault_event_id: event,
      });

    it("lets one caller claim an event for a subscription, and nobody else while it is being sent", async () => {
      const { sub, event } = await pending();
      const first = await claim(sub, event);
      expect(first).toMatchObject({ claimed: true, attempt: 1 });
      expect(await claim(sub, event)).toMatchObject({ claimed: false, id: null });
    });

    it("lets exactly one of two simultaneous claims win", async () => {
      const { sub, event } = await pending();
      const [a, b] = await Promise.all([claim(sub, event), claim(sub, event)]);
      expect([a.claimed, b.claimed].sort()).toEqual([false, true]);
    });

    it("does not claim for a subscription that was switched off or never confirmed", async () => {
      const { sub, event } = await pending();
      await db().rpc("alert_subscription_deactivate", { tenant_id: tenant, id: sub });
      expect(await claim(sub, event)).toMatchObject({ claimed: false });
      const fresh = await create();
      expect(await claim(fresh.id, event)).toMatchObject({ claimed: false });
      expect((await pg.query("select 1 from alerts_sent")).rows).toHaveLength(0);
    });

    it("marks a claim sent or failed once, and keeps the provider's id and a short error", async () => {
      const { sub, event } = await pending();
      const c = await claim(sub, event);
      expect(
        await db().rpc("alert_mark", {
          id: c.id,
          attempt: c.attempt,
          status: "sent",
          provider_id: "m9",
        }),
      ).toEqual({ id: c.id, status: "sent" });
      const r = at(
        (
          await pg.query<{ status: string; provider_id: string | null; error: string | null }>(
            "select status, provider_id, error from alerts_sent",
          )
        ).rows,
      );
      expect(r).toEqual({ status: "sent", provider_id: "m9", error: null });
      // a late second answer does not rewrite it
      expect(
        await db().rpc("alert_mark", {
          id: c.id,
          attempt: c.attempt,
          status: "failed",
          error: "late",
        }),
      ).toBeNull();
      expect(
        at((await pg.query<{ status: string }>("select status from alerts_sent")).rows).status,
      ).toBe("sent");
    });

    it("cuts the error it keeps to 500 characters", async () => {
      const { sub, event } = await pending();
      const c = await claim(sub, event);
      await db().rpc("alert_mark", {
        id: c.id,
        attempt: c.attempt,
        status: "failed",
        error: "x".repeat(900),
      });
      expect(
        at((await pg.query<{ n: number }>("select length(error) as n from alerts_sent")).rows).n,
      ).toBe(500);
    });

    it("does not let a run whose claim was taken over mark the row: the attempt must be the current one", async () => {
      const { sub, event } = await pending();
      const first = await claim(sub, event);
      await pg.query("update alerts_sent set updated_at = now() - interval '3 minutes'");
      const second = await claim(sub, event);
      expect(second).toMatchObject({ claimed: true, attempt: 2 });
      // the first run wakes up late
      expect(
        await db().rpc("alert_mark", {
          id: first.id,
          attempt: first.attempt,
          status: "failed",
          error: "late",
        }),
      ).toBeNull();
      expect(
        at((await pg.query<{ status: string }>("select status from alerts_sent")).rows).status,
      ).toBe("sending");
      expect(
        await db().rpc("alert_mark", { id: second.id, attempt: second.attempt, status: "sent" }),
      ).not.toBeNull();
    });

    it("refuses a mark that is not one", async () => {
      const { sub, event } = await pending();
      const c = await claim(sub, event);
      for (const p of [
        { id: c.id, attempt: 1, status: "sending" },
        { id: c.id, attempt: 1, status: "done" },
        { id: c.id, attempt: 1 },
        { id: "x", attempt: 1, status: "sent" },
        { id: c.id, attempt: "x", status: "sent" },
        { id: null, attempt: 1, status: "sent" },
      ]) {
        await expect(db().rpc("alert_mark", p), JSON.stringify(p)).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
    });

    it("takes a failed claim again only after 5 minutes for each attempt so far, and never past 3 attempts", async () => {
      const { sub, event } = await pending();
      const failIt = async (c: { id: number | null; attempt: number | null }) =>
        db().rpc("alert_mark", { id: c.id, attempt: c.attempt, status: "failed", error: "x" });
      const age = (minutes: number) =>
        pg.query("update alerts_sent set updated_at = now() - ($1 || ' minutes')::interval", [
          String(minutes),
        ]);
      const c1 = await claim(sub, event);
      await failIt(c1);
      await age(4);
      expect(await claim(sub, event)).toMatchObject({ claimed: false }); // 4 < 5 x 1
      await age(6);
      const c2 = await claim(sub, event);
      expect(c2).toMatchObject({ claimed: true, attempt: 2 }); // 6 > 5 x 1
      await failIt(c2);
      await age(9);
      expect(await claim(sub, event)).toMatchObject({ claimed: false }); // 9 < 5 x 2
      await age(11);
      const c3 = await claim(sub, event);
      expect(c3).toMatchObject({ claimed: true, attempt: 3 }); // 11 > 5 x 2
      await failIt(c3);
      await age(600);
      expect(await claim(sub, event)).toMatchObject({ claimed: false }); // 3 attempts is the end
    });

    it("keeps the stuck-claim rule as it was: 2 minutes, whatever the attempt", async () => {
      const { sub, event } = await pending();
      await claim(sub, event);
      await pg.query("update alerts_sent set updated_at = now() - interval '3 minutes'");
      expect(await claim(sub, event)).toMatchObject({ claimed: true, attempt: 2 });
      await pg.query("update alerts_sent set updated_at = now() - interval '3 minutes'");
      expect(await claim(sub, event)).toMatchObject({ claimed: true, attempt: 3 });
    });

    it("refuses a claim that is not one", async () => {
      for (const p of [
        { subscription_id: "nope", vault_event_id: 1 },
        { subscription_id: null, vault_event_id: 1 },
        { subscription_id: "00000000-0000-4000-8000-000000000000", vault_event_id: "x" },
        { subscription_id: "00000000-0000-4000-8000-000000000000" },
      ]) {
        await expect(db().rpc("alert_claim", p), JSON.stringify(p)).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
    });
  });

  describe("alerts_pending", () => {
    it("needs the network, and a limit that is a small positive whole number", async () => {
      for (const p of [
        {},
        { network: "devnet" },
        { network: null },
        { network: "mainnet", limit: 0 },
        { network: "mainnet", limit: "x" },
        { network: "mainnet", limit: 100000 },
        { network: "mainnet", limit: -1 },
      ]) {
        await expect(db().rpc("alerts_pending", p), JSON.stringify(p)).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
      expect(await db().rpc("alerts_pending", { network: "mainnet" })).toEqual([]);
      expect(await db().rpc("alerts_pending", { network: "testnet", limit: 5 })).toEqual([]);
    });

    it("lists a failed alert again only once 5 minutes for each attempt so far have passed", async () => {
      const { id, link_code } = await create();
      await verify({ link_code });
      const e = await pg.query<{ id: string }>(
        "insert into vault_events (tenant_id, event_key, kind, observed_at) values ($1, 'spend:1:held', 'spend_held', now() + interval '1 second') returning id",
        [tenant],
      );
      const event = at(e.rows).id;
      await pg.query(
        "insert into alerts_sent (subscription_id, vault_event_id, status, attempts, updated_at) values ($1, $2, 'failed', 1, now())",
        [id, event],
      );
      const listed = async (age: string, attempts: number, status = "failed") => {
        await pg.query(
          "update alerts_sent set updated_at = now() - $1::interval, attempts = $2, status = $3",
          [age, attempts, status],
        );
        return (await db().rpc<unknown[]>("alerts_pending", { network: "mainnet" })).length;
      };
      expect(await listed("4 minutes", 1)).toBe(0);
      expect(await listed("6 minutes", 1)).toBe(1);
      expect(await listed("9 minutes", 2)).toBe(0);
      expect(await listed("11 minutes", 2)).toBe(1);
      expect(await listed("14 minutes", 3)).toBe(0); // three attempts is the end, however old
      expect(await listed("2 days", 3)).toBe(0);
      // a stuck claim is taken again after 2 minutes, as before
      expect(await listed("1 minute", 1, "sending")).toBe(0);
      expect(await listed("3 minutes", 1, "sending")).toBe(1);
      expect(await listed("3 minutes", 2, "sending")).toBe(1);
      expect(await listed("3 minutes", 3, "sending")).toBe(0);
    });

    it("hands over what dispatch needs for each pending alert, in event order, and nothing secret", async () => {
      const { id, link_code } = await create();
      await verify({ link_code });
      await pg.query(
        `insert into vault_events (tenant_id, event_key, kind, spend_id, mandate_id, amount, code, tx_hash, payload, observed_at)
         values ($1, 'refused:9', 'refused_by_contract', null, 2, '7', 'NoMandate', 'T', '{"a":1}', now() + interval '1 second'),
                ($1, 'spend:1:held', 'spend_held', 1, 2, '5', null, null, '{}', now() + interval '2 seconds')`,
        [tenant],
      );
      const list = await db().rpc<Record<string, unknown>[]>("alerts_pending", {
        network: "mainnet",
      });
      expect(list).toHaveLength(2);
      expect(list.map((p) => (p.event as { event_key: string }).event_key)).toEqual([
        "refused:9",
        "spend:1:held",
      ]);
      expect(at(list)).toMatchObject({
        subscription_id: id,
        channel: "telegram",
        target: CHAT,
        vault_id: V,
        event: {
          kind: "refused_by_contract",
          code: "NoMandate",
          tx_hash: "T",
          mandate_id: 2,
          spend_id: null,
          amount: "7",
          payload: { a: 1 },
        },
      });
      expect(JSON.stringify(list)).not.toContain(link_code);
    });
  });

  describe("the first run's flags (R2)", () => {
    const ev = (key: string) => ({
      tenant_id: tenant,
      event_key: key,
      kind: "anchor",
      anchor_seq: 1,
    });
    const flags = async () =>
      (
        await pg.query<{ event_key: string; initial: boolean }>(
          "select event_key, initial from vault_events order by id",
        )
      ).rows;
    const caughtUp = async () =>
      at(
        (
          await pg.query<{ at: string | null }>(
            "select watch_caught_up_at as at from tenants where id = $1",
            [tenant],
          )
        ).rows,
      ).at;

    it("flags every event of a vault as history until a run says it read everything, and none after", async () => {
      await db().rpc("vault_event_insert", { events: [ev("a:1"), ev("a:2")] });
      await db().rpc("vault_event_insert", { events: [ev("a:3")] });
      expect(await flags()).toEqual([
        { event_key: "a:1", initial: true },
        { event_key: "a:2", initial: true },
        { event_key: "a:3", initial: true },
      ]);
      // a run that moved its cursors but stopped at a cap does not say it
      await db().rpc("tenant_watch_cursor_set", { tenant_id: tenant, spend_from: 1000 });
      await db().rpc("vault_event_insert", { events: [ev("a:4")] });
      expect(await flags()).toContainEqual({ event_key: "a:4", initial: true });
      await db().rpc("tenant_watch_cursor_set", {
        tenant_id: tenant,
        spend_from: 1200,
        caught_up: true,
      });
      await db().rpc("vault_event_insert", { events: [ev("a:5")] });
      expect(await flags()).toContainEqual({ event_key: "a:5", initial: false });
      expect((await flags()).filter((f) => f.initial)).toHaveLength(4);
    });

    it("keeps the first row of a key: an event the first run wrote stays history when it is read again", async () => {
      await db().rpc("vault_event_insert", { events: [ev("a:1")] });
      await db().rpc("tenant_watch_cursor_set", {
        tenant_id: tenant,
        ledger_seq: 3,
        caught_up: true,
      });
      await db().rpc("vault_event_insert", { events: [ev("a:1")] });
      expect(await flags()).toEqual([{ event_key: "a:1", initial: true }]);
    });

    it("sets when the vault caught up only on the run that says so, and never moves it again", async () => {
      expect(await caughtUp()).toBeNull();
      await db().rpc("tenant_watch_cursor_set", { tenant_id: tenant });
      expect(await caughtUp()).toBeNull(); // a touch only
      await db().rpc("tenant_watch_cursor_set", { tenant_id: tenant, anchor_from: 0 });
      expect(await caughtUp()).toBeNull(); // cursors moved, nothing said
      await db().rpc("tenant_watch_cursor_set", {
        tenant_id: tenant,
        ledger_seq: 500,
        caught_up: false,
      });
      expect(await caughtUp()).toBeNull(); // said no
      await db().rpc("tenant_watch_cursor_set", {
        tenant_id: tenant,
        anchor_from: 0,
        caught_up: true,
      });
      const first = await caughtUp();
      expect(first).not.toBeNull();
      await pg.query(
        "update tenants set watch_caught_up_at = '2026-01-01T00:00:00Z' where id = $1",
        [tenant],
      );
      await db().rpc("tenant_watch_cursor_set", {
        tenant_id: tenant,
        spend_from: 5,
        mandate_from: 1,
        anchor_from: 1,
        ledger_seq: 2,
        caught_up: true,
      });
      expect(new Date(String(await caughtUp())).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    });

    it("refuses a caught_up that is not true or false", async () => {
      for (const caught_up of ["maybe", 1, "yes", {}, []]) {
        await expect(
          db().rpc("tenant_watch_cursor_set", { tenant_id: tenant, spend_from: 1, caught_up }),
          JSON.stringify(caught_up),
        ).rejects.toMatchObject({ code: "invalid_input" });
      }
      expect(await caughtUp()).toBeNull();
    });

    it("still moves the cursors and marks the vault as looked at, as 0010 does", async () => {
      await db().rpc("tenant_watch_cursor_set", {
        tenant_id: tenant,
        spend_from: 3,
        mandate_from: 2,
        anchor_from: 1,
        ledger_seq: 9,
      });
      const r = at(
        (
          await pg.query<{ s: string; l: number; fresh: boolean }>(
            "select watch_spend_from s, watch_ledger_seq l, watch_last_at > now() - interval '1 minute' as fresh from tenants where id = $1",
            [tenant],
          )
        ).rows,
      );
      expect([Number(r.s), r.l, r.fresh]).toEqual([3, 9, true]);
    });

    it("keeps the batch's all-or-nothing and the checks it had: a tenant that is gone fails the batch", async () => {
      await expect(
        db().rpc("vault_event_insert", {
          events: [ev("a:1"), { ...ev("a:2"), tenant_id: "00000000-0000-4000-8000-000000000000" }],
        }),
      ).rejects.toBeDefined();
      expect(await flags()).toEqual([]);
    });
  });

  describe("who may call them", () => {
    it("is service_role alone: anon and a signed-in member are refused every alert function, 0010's two included", async () => {
      const all = [...ALERT_FUNCTIONS, ...REDEFINED];
      const privileges = await pg.query<{ fn: string; role: string; ok: boolean }>(
        `select f as fn, r as role, has_function_privilege(r, 'public.' || f || '(jsonb)', 'execute') as ok
           from unnest($1::text[]) f, unnest(array['anon', 'authenticated', 'service_role']) r`,
        [all],
      );
      expect(
        privileges.rows
          .filter((p) => p.ok)
          .map((p) => `${p.fn}:${p.role}`)
          .sort(),
      ).toEqual(all.map((f) => `${f}:service_role`).sort());
      for (const who of [pgliteDb(pg, "anon"), pgliteDb(pg, "authenticated", OWNER)]) {
        for (const fn of all) {
          await expect(who.rpc(fn, {}), fn).rejects.toThrow(/permission denied/);
        }
      }
    });

    it("gives a member no way to read an address or a link code straight from the table", async () => {
      await create({ channel: "email", target: "a@example.com" });
      const { asRole } = await import("./harness");
      await expect(
        asRole(pg, "authenticated", OWNER, (tx) =>
          tx.query("select target from alert_subscriptions"),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asRole(pg, "authenticated", OWNER, (tx) =>
          tx.query("select link_code from alert_subscriptions"),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it("lets a member read neither the new flags' writer nor write any alert row", async () => {
      const { asRole } = await import("./harness");
      for (const sql of [
        "update public.alert_subscriptions set active = false",
        "insert into public.alerts_sent (subscription_id, vault_event_id, status) values (gen_random_uuid(), 1, 'sent')",
        "update public.tenants set watch_caught_up_at = now()",
      ]) {
        await expect(
          asRole(pg, "authenticated", OWNER, (tx) => tx.query(sql)),
          sql,
        ).rejects.toThrow(/permission denied/);
      }
    });
  });
});

/** Migration 0011 on a database that has been running 0010: nobody is caught up until a run says it read everything. */
describe("migration 0011 on a database that ran the watcher", () => {
  it("marks no vault as caught up, whatever its cursors say: only a run that read every list to its end does", async () => {
    const dir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const last = files.findIndex((f) => f.includes("_alerts.sql"));
    expect(last).toBeGreaterThan(0);
    const pg = new PGlite();
    try {
      await pg.exec(SUPABASE_STUB);
      for (const f of files.slice(0, last)) await pg.exec(readFileSync(`${dir}/${f}`, "utf8"));
      const t = async (vault: string, set: string) => {
        const r = await pg.query<{ id: string }>(
          "insert into tenants (vault_id, network, kind, owner_account) values ($1, 'mainnet', 'external', 'o.near') returning id",
          [vault],
        );
        await pg.query(`update tenants set ${set} where id = $1`, [at(r.rows).id]);
        return at(r.rows).id;
      };
      // A cursor past 0 could be the end of a short list or the cap of a long one: the migration cannot tell.
      await t(
        "ran.vaults.probarion.near",
        "watch_spend_from = 1000, watch_last_at = '2026-11-05T00:00:00Z'",
      );
      await t(
        "ledger.vaults.probarion.near",
        "watch_ledger_seq = 500, watch_last_at = '2026-11-05T01:00:00Z'",
      );
      await t("touched.vaults.probarion.near", "watch_last_at = '2026-11-05T02:00:00Z'");
      await t("never.vaults.probarion.near", "watch_ledger_seq = 0");
      await pg.exec(readFileSync(`${dir}/${files[last]}`, "utf8"));
      const rows = await pg.query<{ at: string | null }>(
        "select watch_caught_up_at as at from tenants",
      );
      expect(rows.rows).toHaveLength(4);
      expect(rows.rows.every((r) => r.at === null)).toBe(true);
    } finally {
      await pg.close();
    }
  }, 60_000);
});
