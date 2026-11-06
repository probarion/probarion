import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { type DispatchDeps, dispatchAlerts, type Senders } from "@/lib/alerts/dispatch";
import { formatAlert } from "@/lib/alerts/format";
import type { SendResult } from "@/lib/alerts/telegram";
import { quietLogs } from "../fixtures/quiet-logs";
import { freshDb, seedTenant } from "./harness";
import { at } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

const V = "acme.vaults.probarion.near";
const OWNER = "acme.near";
const CHAT = "424242";
const EMAIL = "owner@example.com";
const TX = "8vYQ4Nn1ZDLmWQ4TqkRkYHq1sV3xUq1m2F7ZB8pVwx6a";

// The real formatAlert, as a spy: one test makes a call throw.
vi.mock("@/lib/alerts/format", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/alerts/format")>();
  return { ...actual, formatAlert: vi.fn(actual.formatAlert) };
});

const logs = quietLogs();

describe("dispatchAlerts", () => {
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
    // One database for the file: what a test made is removed, the tenant stays.
    await pg.exec("delete from vault_events; delete from alert_subscriptions;");
    await pg.exec("delete from tenants where vault_id <> 'acme.vaults.probarion.near';");
    await pg.query("update tenants set watch_caught_up_at = null where id = $1", [tenant]);
  });

  const db = () => pgliteDb(pg);

  /** An event the watcher already recorded after its first run: `initial` is false, as for any later event. */
  const event = async (
    key: string,
    kind: string,
    over: {
      offset?: string;
      payload?: Record<string, unknown>;
      tenant?: string;
      code?: string;
      initial?: boolean;
    } = {},
  ) => {
    const r = await pg.query<{ id: string }>(
      `insert into vault_events (tenant_id, event_key, kind, spend_id, mandate_id, amount, code, tx_hash, payload, initial, observed_at)
       values ($1, $2, $3, 1, 2, '5000000', $4, $5, $6::jsonb, $7, now() + $8::interval) returning id`,
      [
        over.tenant ?? tenant,
        key,
        kind,
        over.code ?? null,
        kind === "refused_by_contract" ? TX : null,
        JSON.stringify(over.payload ?? {}),
        over.initial ?? false,
        over.offset ?? "1 second",
      ],
    );
    return Number(at(r.rows).id);
  };

  async function telegramSub(kinds?: string[], forTenant = tenant) {
    const { id, link_code } = await db().rpc<{ id: string; link_code: string }>(
      "alert_subscription_create",
      { tenant_id: forTenant, channel: "telegram", created_by: OWNER, ...(kinds ? { kinds } : {}) },
    );
    await db().rpc("alert_subscription_verify", { channel: "telegram", link_code, target: CHAT });
    return id;
  }
  async function emailSub(forTenant = tenant) {
    const { id, link_code } = await db().rpc<{ id: string; link_code: string }>(
      "alert_subscription_create",
      { tenant_id: forTenant, channel: "email", target: EMAIL, created_by: OWNER },
    );
    await db().rpc("alert_subscription_verify", { channel: "email", link_code });
    return id;
  }

  type Telegram = Mock<(chatId: string, text: string) => Promise<SendResult>>;
  const senders = (
    telegram: Telegram = vi.fn(async (_chatId: string, _text: string) => ({
      ok: true as const,
      id: "m1",
    })),
  ) => {
    const email = { send: vi.fn(async () => ({ ok: true as const, id: "e1" })) };
    return { telegram, email, tg: telegram } satisfies Senders & { tg: Telegram };
  };
  const stopLinks = async (id: string) => ({
    page: `https://probarion.xyz/alerts/stop?s=${id}&t=tok`,
    oneClick: `https://probarion.xyz/api/alerts/stop?s=${id}&t=tok`,
  });
  const run = (s: Senders, over: Partial<DispatchDeps> = {}) =>
    dispatchAlerts({
      db: db(),
      senders: s,
      network: "mainnet",
      origin: "https://probarion.xyz",
      stopLinks,
      ...over,
    });
  /** Makes what a run left in alerts_sent older, as the passing of time does: the retries are spaced (5 minutes an attempt). */
  const later = (interval = "1 hour") =>
    pg.query("update alerts_sent set updated_at = updated_at - $1::interval", [interval]);
  const sentRows = async () =>
    (
      await pg.query<{ status: string; attempts: number; error: string | null }>(
        "select status, attempts, error from alerts_sent order by id",
      )
    ).rows;

  it("links Telegram by code and sends each new event once", async () => {
    await telegramSub();
    await event("spend:1:held", "spend_held");
    const s = senders();
    expect(await run(s)).toMatchObject({ sent: 1 });
    expect(s.tg).toHaveBeenCalledWith(CHAT, expect.stringContaining("Approval needed"));
    expect(await run(s)).toMatchObject({ sent: 0 });
    expect(s.tg).toHaveBeenCalledTimes(1);
  });

  it("sends a Telegram message as subject, a blank line and the text, ending with /stop", async () => {
    await telegramSub();
    await event("spend:1:held", "spend_held");
    const s = senders();
    await run(s);
    const text = String(at(s.tg.mock.calls as unknown as string[][])[1]);
    expect(text.startsWith(`[Probarion] Approval needed: 5 USDC on ${V}\n\n`)).toBe(true);
    expect(text.split("\n").at(-1)).toContain("send /stop");
  });

  // probarion-claim: ALERTS
  it("never double-sends when two cron runs overlap (Review Focus #3)", async () => {
    await telegramSub();
    await event("spend:1:paid", "spend_paid");
    const s = senders();
    const [a, b] = await Promise.all([run(s), run(s)]);
    expect(a.sent + b.sent).toBe(1);
    expect(s.tg).toHaveBeenCalledTimes(1);
  });

  it("sends an email with its idempotency key, its one-click address and a stop link in the text", async () => {
    const sub = await emailSub();
    const eventId = await event("spend:1:held", "spend_held");
    const s = senders();
    expect(await run(s)).toMatchObject({ sent: 1 });
    expect(s.email.send).toHaveBeenCalledTimes(1);
    const sent = at(at(s.email.send.mock.calls as unknown as Record<string, string>[][]));
    expect(sent).toMatchObject({
      to: EMAIL,
      subject: `[Probarion] Approval needed: 5 USDC on ${V}`,
      idempotencyKey: `alert-${sub}-${eventId}`,
      unsubscribeUrl: `https://probarion.xyz/api/alerts/stop?s=${sub}&t=tok`,
    });
    expect(sent.text).toContain(`https://probarion.xyz/alerts/stop?s=${sub}&t=tok`);
    expect(sent.text.split("\n").at(-1)).toMatch(
      /^Stop or change alerts: stop these emails https:/,
    );
    expect(s.tg).not.toHaveBeenCalled();
  });

  it("sends one event to every subscription that wants it, once each", async () => {
    await telegramSub();
    await emailSub();
    await event("spend:1:paid", "spend_paid");
    const s = senders();
    expect(await run(s)).toMatchObject({ sent: 2, failed: 0 });
    expect(await run(s)).toMatchObject({ sent: 0 });
    expect(await sentRows()).toHaveLength(2);
  });

  describe("failures", () => {
    it("retries a failed send up to 3 times, then stops", async () => {
      await telegramSub();
      await event("spend:1:held", "spend_held");
      const failing = senders(vi.fn(async () => ({ ok: false as const, error: "429" })));
      for (let i = 0; i < 5; i++) {
        await run(failing);
        await later();
      }
      expect(failing.tg).toHaveBeenCalledTimes(3);
      expect(await sentRows()).toEqual([{ status: "failed", attempts: 3, error: "429" }]);
    });

    it("counts a send that throws as a failure, keeps going, and sends the next alert", async () => {
      await telegramSub();
      await event("spend:1:held", "spend_held");
      await event("spend:2:paid", "spend_paid");
      const tg = vi
        .fn()
        .mockRejectedValueOnce(new Error("socket hang up"))
        .mockResolvedValue({ ok: true, id: "m2" });
      expect(await run(senders(tg))).toMatchObject({ sent: 1, failed: 1 });
      // the failed one goes out on a later run
      await later();
      expect(await run(senders(tg))).toMatchObject({ sent: 1, failed: 0 });
    });

    it("sends a failed alert on a later run once the provider answers", async () => {
      await telegramSub();
      await event("spend:1:held", "spend_held");
      const tg = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: "502" })
        .mockResolvedValue({ ok: true, id: "m1" });
      expect(await run(senders(tg))).toMatchObject({ sent: 0, failed: 1 });
      await later();
      expect(await run(senders(tg))).toMatchObject({ sent: 1, failed: 0 });
      expect(await sentRows()).toEqual([{ status: "sent", attempts: 2, error: null }]);
    });

    it("leaves a failed alert alone until 5 minutes for each attempt so far have passed, so a short outage does not use up the three", async () => {
      await telegramSub();
      await event("spend:1:held", "spend_held");
      const tg = vi.fn(async () => ({ ok: false as const, error: "502" }));
      const s = senders(tg);
      expect(await run(s)).toMatchObject({ failed: 1 }); // attempt 1
      expect(await run(s)).toMatchObject({ failed: 0, sent: 0 }); // the very next run: nothing
      await later("4 minutes");
      expect(await run(s)).toMatchObject({ failed: 0, sent: 0 }); // 4 < 5
      await later("2 minutes");
      expect(await run(s)).toMatchObject({ failed: 1 }); // 6 > 5: attempt 2
      await later("9 minutes");
      expect(await run(s)).toMatchObject({ failed: 0 }); // 9 < 10
      await later("2 minutes");
      expect(await run(s)).toMatchObject({ failed: 1 }); // 11 > 10: attempt 3
      await later("5 hours");
      expect(await run(s)).toMatchObject({ failed: 0 }); // three is the end
      expect(tg).toHaveBeenCalledTimes(3);
    });

    it("does not let one alert that cannot be made stop the run: it is marked failed with a short sentence, and the next goes out", async () => {
      await telegramSub();
      await event("spend:1:held", "spend_held");
      await event("spend:2:paid", "spend_paid");
      vi.mocked(formatAlert).mockImplementationOnce(() => {
        throw new Error("poison: owner@example.com 424242");
      });
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 1, failed: 1 });
      expect(s.tg).toHaveBeenCalledTimes(1);
      const rows = await sentRows();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        status: "failed",
        attempts: 1,
        error: "the message could not be made",
      });
      expect(rows[1]).toMatchObject({ status: "sent" });
      const line = logs.lines.find((l) => l.includes("alerts.item_failed"));
      expect(line).toBeDefined();
      expect(line).not.toContain("owner@example.com");
      expect(line).not.toContain(CHAT);
      // the one that failed is not lost: it is tried again later, and goes out once it can be made
      await later();
      expect(await run(s)).toMatchObject({ sent: 1, failed: 0 });
    });

    it("makes a message for an event whose payload is not an object, instead of failing on it", async () => {
      await telegramSub();
      await pg.query(
        `insert into vault_events (tenant_id, event_key, kind, payload, observed_at)
         values ($1, 'allowance_low:k:2026-11-11', 'allowance_low', 'null'::jsonb, now() + interval '1 second')`,
        [tenant],
      );
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 1, failed: 0 });
      expect(String(at(s.tg.mock.calls as unknown as string[][])[1])).toContain("gas allowance");
    });

    it("logs the channel and the ids, and never an address, a chat id, a message or more than 200 characters of the provider's error", async () => {
      await emailSub();
      await telegramSub();
      const eventId = await event("spend:1:held", "spend_held");
      const tail = "x".repeat(400);
      const s = senders(
        vi.fn(async () => ({
          ok: false as const,
          error: `Bad Request: chat ${CHAT} not found ${tail}`,
        })),
      );
      s.email.send.mockResolvedValue({
        ok: false as never,
        error: `Invalid to field: ${EMAIL} ${tail}`,
      } as never);
      await run(s);
      const lines = logs.lines.filter((l) => l.includes("alerts.send_failed"));
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        expect(entry.event_id).toBe(eventId);
        expect(["telegram", "email"]).toContain(entry.channel);
        expect(typeof entry.subscription_id).toBe("string");
        expect(String(entry.error).length).toBeLessThanOrEqual(200);
      }
      const all = logs.lines.join("\n");
      expect(all).not.toContain(EMAIL);
      expect(all).not.toContain(CHAT);
      expect(all).not.toContain("Approval needed");
      expect(all).not.toContain(V);
      // the row keeps the provider's words too, without the address
      const rows = await sentRows();
      expect(rows.every((r) => r.status === "failed" && !String(r.error).includes(EMAIL))).toBe(
        true,
      );
    });
  });

  describe("who gets what", () => {
    it("respects subscription kinds, verification and the subscription start time", async () => {
      await event("spend:0:held", "spend_held", { offset: "-1 hour" }); // before the subscription existed
      await telegramSub(["spend_held"]);
      await event("refused:3", "refused_by_contract");
      await db().rpc("alert_subscription_create", {
        tenant_id: tenant,
        channel: "email",
        target: EMAIL,
        created_by: OWNER,
      }); // unverified
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 0 });
      expect(s.email.send).not.toHaveBeenCalled();
      expect(s.tg).not.toHaveBeenCalled();
    });

    it("sends only the kinds a subscription chose", async () => {
      await telegramSub(["spend_held"]);
      await event("refused:3", "refused_by_contract");
      await event("spend:2:paid", "spend_paid");
      await event("spend:3:held", "spend_held");
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 1 });
      expect(String(at(s.tg.mock.calls as unknown as string[][])[1])).toContain("Approval needed");
    });

    it("sends the default kinds, near_low included, and none of the kinds nobody asked for", async () => {
      await telegramSub();
      await event("near_low:2026-11-11", "near_low", {
        payload: { free_yocto: "30000000000000000000000" },
      });
      await event("allowance_low:k:2026-11-11", "allowance_low");
      await event("anchor:1", "anchor");
      await event("mandate:1", "mandate_created");
      await event("spend:9:rejected", "spend_rejected");
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 2 });
      const texts = (s.tg.mock.calls as unknown as string[][]).map((c) => String(c[1]));
      expect(texts.some((t) => t.includes("Vault is low on NEAR"))).toBe(true);
      expect(texts.some((t) => t.includes("gas allowance low"))).toBe(true);
    });

    it("does not send an event older than 24 hours, even to a subscription that is older still", async () => {
      await telegramSub();
      await pg.query("update alert_subscriptions set created_at = now() - interval '3 days'");
      await event("spend:1:held", "spend_held", { offset: "-25 hours" });
      await event("spend:2:held", "spend_held", { offset: "-23 hours" });
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 1 });
    });

    it("sends an event seen between the subscription's creation and its confirmation, once it is confirmed", async () => {
      const { link_code } = await db().rpc<{ link_code: string }>("alert_subscription_create", {
        tenant_id: tenant,
        channel: "telegram",
        created_by: OWNER,
      });
      await event("spend:1:held", "spend_held");
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 0 });
      await db().rpc("alert_subscription_verify", { channel: "telegram", link_code, target: CHAT });
      expect(await run(s)).toMatchObject({ sent: 1 });
    });

    it("sends nothing to a subscription that was removed, even for an event it had not sent yet", async () => {
      const id = await telegramSub();
      await event("spend:1:held", "spend_held");
      await db().rpc("alert_subscription_deactivate", { tenant_id: tenant, id });
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 0 });
      expect(s.tg).not.toHaveBeenCalled();
    });

    it("does not send an event of another tenant", async () => {
      await telegramSub();
      const other = await seedTenant(pg, {
        vault: "other.vaults.probarion.near",
        owner: "other.near",
      });
      await event("spend:1:held", "spend_held", { tenant: other });
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 0 });
    });

    it("leaves a tenant of the other network alone", async () => {
      await telegramSub();
      await pg.query(
        "insert into tenants (vault_id, network, kind, owner_account) values ('t.vaults.testnet', 'testnet', 'external', 't.testnet')",
      );
      await event("spend:1:held", "spend_held");
      const s = senders();
      expect(await run(s, { network: "testnet" })).toMatchObject({ sent: 0 });
      expect(await run(s, { network: "mainnet" })).toMatchObject({ sent: 1 });
    });
  });

  describe("a vault's first run (R2)", () => {
    const first = (key: string, kind: string, payload: Record<string, unknown> = {}) => ({
      tenant_id: tenant,
      event_key: key,
      kind,
      spend_id: 1,
      amount: "5000000",
      payload,
    });
    const HOUR_NS = 3_600_000_000_000n;
    const inNs = (hours: bigint) => String(BigInt(Date.now()) * 1_000_000n + hours * HOUR_NS);

    it("sends none of the history a first run recorded, only what is still true: an open hold, a low key, a low vault", async () => {
      await telegramSub(); // subscribed before the vault was ever watched
      await db().rpc("vault_event_insert", {
        events: [
          first("spend:1:paid", "spend_paid"),
          first("spend:2:burned", "spend_burned"),
          first("spend:3:failed", "spend_failed"),
          first("refused:4", "refused_by_contract"),
          first("spend:5:held", "spend_held", { held_until_ns: inNs(-1n) }), // its window ended
          first("spend:6:held", "spend_held"), // no end recorded
          first("spend:7:held", "spend_held", { held_until_ns: "x1" }),
          first("spend:8:held", "spend_held", { held_until_ns: inNs(48n) }), // still open
          first("allowance_low:k:2026-11-11", "allowance_low"),
          first("near_low:2026-11-11", "near_low"),
        ],
      });
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 3 });
      const texts = (s.tg.mock.calls as unknown as string[][]).map((c) => String(c[1]));
      expect(texts.filter((t) => t.includes("Approval needed"))).toHaveLength(1);
      expect(texts.some((t) => t.includes("gas allowance low"))).toBe(true);
      expect(texts.some((t) => t.includes("Vault is low on NEAR"))).toBe(true);
      expect(texts.some((t) => t.includes("was paid on NEAR"))).toBe(false);
    });

    it("sends none of a long history that took several runs to read: a run that stopped at a cap has not caught up", async () => {
      await telegramSub();
      const slice = (from: number, to: number) => ({
        events: Array.from({ length: to - from }, (_, i) =>
          first(`spend:${from + i}:paid`, "spend_paid"),
        ),
      });
      // run 1 read a full slice and moved its cursor, but did not say it had read everything
      await db().rpc("vault_event_insert", slice(1, 1001));
      await db().rpc("tenant_watch_cursor_set", { tenant_id: tenant, spend_from: 1000 });
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 0 });
      // run 2 read the rest, to its end, and says so (after writing its events)
      await db().rpc("vault_event_insert", slice(1001, 1151));
      await db().rpc("tenant_watch_cursor_set", {
        tenant_id: tenant,
        spend_from: 1150,
        caught_up: true,
      });
      expect(await run(s)).toMatchObject({ sent: 0 }); // old spends 1001 to 1150 are history too
      // run 3: a payment that really is new
      await db().rpc("vault_event_insert", slice(1151, 1152));
      expect(await run(s)).toMatchObject({ sent: 1 });
    });

    it("still flags a first run that failed part way: until the cursors are written, the next run's events are history too", async () => {
      await telegramSub();
      await db().rpc("vault_event_insert", { events: [first("spend:1:paid", "spend_paid")] });
      await db().rpc("tenant_watch_cursor_set", { tenant_id: tenant }); // a touch is not a finished run
      await db().rpc("vault_event_insert", { events: [first("spend:2:paid", "spend_paid")] });
      expect(await run(senders())).toMatchObject({ sent: 0 });
    });

    it("sends an event normally once a first run has finished, and the history stays unsent", async () => {
      await telegramSub();
      await db().rpc("vault_event_insert", { events: [first("spend:1:paid", "spend_paid")] });
      await db().rpc("tenant_watch_cursor_set", {
        tenant_id: tenant,
        spend_from: 1,
        mandate_from: 0,
        anchor_from: 0,
        ledger_seq: 0,
        caught_up: true,
      });
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 0 });
      await db().rpc("vault_event_insert", { events: [first("spend:2:paid", "spend_paid")] });
      expect(await run(s)).toMatchObject({ sent: 1 });
      expect(await run(s)).toMatchObject({ sent: 0 });
    });
  });

  describe("the Canary (R4)", () => {
    it("never alerts a refusal by the contract for a canary vault, and still alerts its other kinds", async () => {
      const canary = await seedTenant(pg, {
        vault: "canary.vaults.probarion.near",
        owner: "canary.near",
        kind: "canary",
      });
      await telegramSub(undefined, canary);
      await event("refused:1", "refused_by_contract", { tenant: canary });
      await event("refused:2", "refused_by_contract", { tenant: canary });
      await event("spend:3:paid", "spend_paid", { tenant: canary });
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 1 });
      expect(String(at(s.tg.mock.calls as unknown as string[][])[1])).toContain("Paid 5 USDC");
    });

    it("alerts a refusal for every other kind of vault", async () => {
      for (const kind of ["team", "external"] as const) {
        const t = await seedTenant(pg, {
          vault: `${kind}.vaults.probarion.near`,
          owner: `${kind}.near`,
          kind,
        });
        await telegramSub(undefined, t);
        await event(`refused:${kind}`, "refused_by_contract", { tenant: t });
      }
      expect(await run(senders())).toMatchObject({ sent: 2 });
    });
  });

  describe("channels without a sender", () => {
    it("skips a channel with no configured sender without claiming the event", async () => {
      await telegramSub();
      await event("spend:1:held", "spend_held");
      expect(await run({ telegram: null, email: null })).toMatchObject({ sent: 0, skipped: 1 });
      expect((await pg.query("select 1 from alerts_sent")).rows).toHaveLength(0);
      // the sender comes back: the event is still there to send
      expect(await run(senders())).toMatchObject({ sent: 1, skipped: 0 });
    });

    it("sends the channel that has a sender and skips the one that has none", async () => {
      await telegramSub();
      await emailSub();
      await event("spend:1:held", "spend_held");
      const s = senders();
      expect(await run({ telegram: s.telegram, email: null })).toMatchObject({
        sent: 1,
        skipped: 1,
      });
    });
  });

  describe("a claim that was left behind (R9)", () => {
    const strand = async (status: string, attempts: number, age: string) => {
      const id = await telegramSub();
      const eventId = await event("spend:1:held", "spend_held");
      await pg.query(
        `insert into alerts_sent (subscription_id, vault_event_id, status, attempts, updated_at) values ($1, $2, $3, $4, now() - $5::interval)`,
        [id, eventId, status, attempts, age],
      );
    };

    it("takes a send that has been 'sending' for more than 2 minutes again, once more", async () => {
      await strand("sending", 1, "3 minutes");
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 1 });
      expect(await sentRows()).toEqual([{ status: "sent", attempts: 2, error: null }]);
    });

    it("leaves a send that started a moment ago to the run that is sending it", async () => {
      await strand("sending", 1, "20 seconds");
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 0 });
      expect(s.tg).not.toHaveBeenCalled();
    });

    it("gives up on a claim that keeps dying: three attempts, then no more", async () => {
      await strand("sending", 3, "10 minutes");
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 0 });
      expect(s.tg).not.toHaveBeenCalled();
    });

    it("never sends again what was sent", async () => {
      await strand("sent", 1, "10 minutes");
      const s = senders();
      expect(await run(s)).toMatchObject({ sent: 0 });
    });
  });

  describe("the deadline (R9)", () => {
    it("claims nothing once the deadline has passed, says how many it left, and the next run sends them", async () => {
      await telegramSub();
      await event("spend:1:held", "spend_held");
      await event("spend:2:paid", "spend_paid");
      await event("spend:3:paid", "spend_paid");
      const now = vi.fn().mockReturnValueOnce(999).mockReturnValue(1000);
      const s = senders();
      expect(await run(s, { deadline: 1000, now })).toMatchObject({
        sent: 1,
        failed: 0,
        deferred: 2,
      });
      expect(s.tg).toHaveBeenCalledTimes(1);
      expect(await sentRows()).toHaveLength(1);
      expect(await run(s)).toMatchObject({ sent: 2, deferred: 0 });
    });

    it("sends everything when there is no deadline, and nothing at all when it is already past", async () => {
      await telegramSub();
      await event("spend:1:held", "spend_held");
      const s = senders();
      expect(await run(s, { deadline: 1, now: () => 2 })).toMatchObject({ sent: 0, deferred: 1 });
      expect(s.tg).not.toHaveBeenCalled();
      expect(await run(s)).toMatchObject({ sent: 1 });
    });
  });

  describe("a send never outlives the function (the hard limit)", () => {
    /** The delays asked of setTimeout while a run goes, so a test can see how long a send was given. */
    const delays = () => {
      const seen: number[] = [];
      const real = globalThis.setTimeout;
      const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: () => void,
        ms?: number,
        ...rest: unknown[]
      ) => {
        if (typeof ms === "number") seen.push(ms);
        return real(fn, ms, ...rest);
      }) as typeof setTimeout);
      return { seen, stop: () => spy.mockRestore() };
    };

    it("gives a send the smaller of its normal 12 s and what is left of the limit, less a 2 s margin", async () => {
      await telegramSub();
      await event("spend:1:held", "spend_held");
      const t = delays();
      try {
        // 6.5 s before the limit: 4.5 s for the send
        await run(senders(), { deadline: 100_000, hardLimit: 105_500, now: () => 99_000 });
        expect(t.seen).toContain(4_500);
        expect(t.seen).not.toContain(12_000);
      } finally {
        t.stop();
      }
    });

    it("keeps the normal timeout when there is plenty of time, and when there is no deadline at all", async () => {
      await telegramSub();
      await event("spend:1:held", "spend_held");
      await event("spend:2:paid", "spend_paid");
      const t = delays();
      try {
        await run(senders(), { deadline: 1_000_000, hardLimit: 2_000_000, now: () => 0 });
        await later("1 hour"); // (nothing failed; this keeps the helper honest)
        expect(t.seen.filter((ms) => ms === 12_000)).toHaveLength(2);
        await pg.exec("delete from alerts_sent");
        t.seen.length = 0;
        await run(senders());
        expect(t.seen.filter((ms) => ms === 12_000)).toHaveLength(2);
      } finally {
        t.stop();
      }
    });

    it("takes the limit as 5 s after the deadline when it is not given: the cron's 55 s and 60 s", async () => {
      await telegramSub();
      await event("spend:1:held", "spend_held");
      const t = delays();
      try {
        await run(senders(), { deadline: 55_000, now: () => 54_000 }); // 6 s left: 4 s for the send
        expect(t.seen).toContain(4_000);
      } finally {
        t.stop();
      }
    });

    it("starts no send with less than 3 s left, claims nothing for it, and counts it as deferred", async () => {
      await telegramSub();
      await event("spend:1:held", "spend_held");
      await event("spend:2:paid", "spend_paid");
      const s = senders();
      const r = await run(s, { deadline: 100_000, hardLimit: 102_998, now: () => 99_999 }); // 2_999 left
      expect(r).toMatchObject({ sent: 0, failed: 0, deferred: 2 });
      expect(s.tg).not.toHaveBeenCalled();
      expect((await pg.query("select 1 from alerts_sent")).rows).toHaveLength(0);
      // with exactly 3 s left it does start
      const ok = await run(s, { deadline: 100_000, hardLimit: 102_999, now: () => 99_999 });
      expect(ok).toMatchObject({ sent: 2, deferred: 0 });
    });

    it("stops starting sends once one has used the time: the rest wait for the next run", async () => {
      await telegramSub();
      for (const n of [1, 2, 3]) await event(`spend:${n}:paid`, "spend_paid");
      const clock = vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1_000)
        .mockReturnValue(9_000);
      const s = senders();
      // limit 10 s: at 0 s and 1 s there is time, at 9 s there is 1 s left: not enough to start
      const r = await run(s, { deadline: 9_500, hardLimit: 10_000, now: clock });
      expect(r).toMatchObject({ sent: 2, deferred: 1 });
    });
  });

  describe("limits", () => {
    it("takes at most `limit` alerts a run, oldest event first", async () => {
      await telegramSub();
      for (const n of [1, 2, 3]) await event(`spend:${n}:paid`, "spend_paid");
      const s = senders();
      expect(await run(s, { limit: 2 })).toMatchObject({ sent: 2 });
      expect(await run(s, { limit: 2 })).toMatchObject({ sent: 1 });
      expect(s.tg).toHaveBeenCalledTimes(3);
    });

    it("does not let a stuck send hold up the clock: it times out and counts as failed", async () => {
      await telegramSub();
      await event("spend:1:held", "spend_held");
      const hang = vi.fn(() => new Promise<never>(() => {}));
      const r = await run(senders(hang as never), { sendTimeoutMs: 20 });
      expect(r).toMatchObject({ sent: 0, failed: 1 });
      expect(await sentRows()).toEqual([{ status: "failed", attempts: 1, error: "timeout" }]);
    });
  });
});
