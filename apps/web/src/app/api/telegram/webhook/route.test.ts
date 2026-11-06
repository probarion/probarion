import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { freshDb, seedTenant } from "../../../../../test/db/harness";
import { pgliteDb } from "../../../../../test/db/pglite-db";
import { quietLogs } from "../../../../../test/fixtures/quiet-logs";

// The webhook with its settings, the key, the database (PGlite, so the real SQL answers) and the Telegram call replaced.
// The parsing, the secret, the response helpers, the rate limit and the logger are real.
const h = vi.hoisted(() => ({
  env: vi.fn(),
  db: null as unknown as Db,
  sendTelegram: vi.fn(),
}));

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));

vi.mock("@/lib/env", () => ({ getEnv: h.env }));
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => h.db }));
vi.mock("@/lib/crypto/server", () => ({
  subkey: (purpose: Parameters<typeof deriveSubkey>[1]) => deriveSubkey(MASTER, purpose),
}));
vi.mock("@/lib/alerts/telegram", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/alerts/telegram")>()),
  sendTelegram: h.sendTelegram,
}));

import { telegramWebhookSecret } from "@/lib/alerts/telegram";
import * as route from "./route";

const logs = quietLogs();

const TOKEN = `123456789:AAH${"x".repeat(32)}`;
const V = "acme.vaults.probarion.near";
const OTHER_V = "other.vaults.probarion.near";
const CHAT = 424242;

let pg: PGlite;
let tenant: string;
let other: string;
let secret: string;

beforeAll(async () => {
  pg = await freshDb();
  h.db = pgliteDb(pg);
  tenant = await seedTenant(pg, { vault: V, owner: "acme.near" });
  other = await seedTenant(pg, { vault: OTHER_V, owner: "other.near" });
  secret = await telegramWebhookSecret(await deriveSubkey(MASTER, "telegram"));
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec("delete from alert_subscriptions; delete from rate_limits;");
  h.env.mockReset();
  h.sendTelegram.mockReset();
  h.env.mockReturnValue({ TELEGRAM_BOT_TOKEN: TOKEN });
  h.sendTelegram.mockResolvedValue({ ok: true, id: "1" });
});

const call = (
  body: unknown,
  headers: Record<string, string> = { "x-telegram-bot-api-secret-token": secret },
) =>
  route.POST(
    new Request("https://probarion.example/api/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const message = (text: string, chat: number | string = CHAT) => ({
  update_id: 1,
  message: { chat: { id: chat }, text },
});
const newCode = async (t = tenant) =>
  (
    await h.db.rpc<{ link_code: string }>("alert_subscription_create", {
      tenant_id: t,
      channel: "telegram",
      created_by: "x.near",
    })
  ).link_code;
const subs = async () =>
  (
    await pg.query<{
      tenant_id: string;
      target: string | null;
      active: boolean;
      verified_at: string | null;
    }>("select tenant_id, target, active, verified_at from alert_subscriptions order by created_at")
  ).rows;
const reply = () => String(h.sendTelegram.mock.calls[0]?.[2]);

describe("POST /api/telegram/webhook", () => {
  it("is a POST route that is never cached", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic"]);
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("answers 503 when there is no bot token, and does nothing", async () => {
    h.env.mockReturnValue({ TELEGRAM_BOT_TOKEN: null });
    const res = await call(message(`/start ${await newCode()}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured" });
    expect(h.sendTelegram).not.toHaveBeenCalled();
    expect((await subs())[0]?.verified_at).toBeNull();
  });

  it("answers 503 when the settings cannot be read", async () => {
    h.env.mockImplementation(() => {
      throw new Error("Invalid environment: SUPABASE_URL is required");
    });
    expect((await call(message("/stop"))).status).toBe(503);
  });

  it("answers 401 without the secret header, with a wrong one, and with a prefix or an extension of the right one", async () => {
    const code = await newCode();
    const wrong: Record<string, string>[] = [
      {},
      { "x-telegram-bot-api-secret-token": "" },
      { "x-telegram-bot-api-secret-token": "nope" },
      { "x-telegram-bot-api-secret-token": secret.slice(0, -1) },
      { "x-telegram-bot-api-secret-token": `${secret}0` },
      { "x-telegram-bot-api-secret-token": secret.toUpperCase() },
    ];
    for (const headers of wrong) {
      const res = await call(message(`/start ${code}`), headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(h.sendTelegram).not.toHaveBeenCalled();
    expect((await subs())[0]?.verified_at).toBeNull();
  });

  it("takes a wrong secret before it reads the body or touches the rate limit", async () => {
    const res = await route.POST(
      new Request("https://probarion.example/api/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "nope" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(401);
    expect((await pg.query("select 1 from rate_limits")).rows).toHaveLength(0);
  });

  it("answers 429 once a minute's budget is used, and does nothing for those calls", async () => {
    await pg.query(
      "insert into rate_limits (bucket, window_start, count) values ('telegram:webhook', now(), 120)",
    );
    const code = await newCode();
    const res = await call(message(`/start ${code}`));
    expect(res.status).toBe(429);
    expect(h.sendTelegram).not.toHaveBeenCalled();
    expect((await subs())[0]?.verified_at).toBeNull();
  });

  describe("/start <code>", () => {
    it("links the chat to the vault, says so with the kinds in plain words, and answers 200", async () => {
      const code = await newCode();
      const res = await call(message(`/start ${code}`));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(await subs()).toMatchObject([
        { tenant_id: tenant, target: String(CHAT), active: true },
      ]);
      expect((await subs())[0]?.verified_at).not.toBeNull();
      expect(h.sendTelegram).toHaveBeenCalledTimes(1);
      expect(h.sendTelegram.mock.calls[0]?.slice(0, 2)).toEqual([TOKEN, String(CHAT)]);
      expect(reply()).toBe(
        `Linked to ${V}. You will get a message when a spend waits for approval, the contract refuses a spend, a spend is paid, a payout goes out to Base, a payout fails, an agent key's gas allowance runs low and the vault's free NEAR runs low. Send /stop to end alerts.`,
      );
      expect(reply()).not.toMatch(/_/);
    });

    it("works once: the same code again says the link is used up and changes nothing", async () => {
      const code = await newCode();
      await call(message(`/start ${code}`));
      h.sendTelegram.mockClear();
      const res = await call(message(`/start ${code}`, 999));
      expect(res.status).toBe(200);
      expect(reply()).toBe(
        "That link has expired or was already used. Create a new one in the Probarion console.",
      );
      expect(await subs()).toHaveLength(1);
      expect((await subs())[0]?.target).toBe(String(CHAT));
    });

    it("says the link has expired for a code that is unknown, mistyped or older than 24 hours", async () => {
      const old = await newCode();
      await pg.query("update alert_subscriptions set created_at = now() - interval '25 hours'");
      for (const text of [`/start ${"0".repeat(32)}`, "/start abcdefgh", `/start ${old}`]) {
        h.sendTelegram.mockClear();
        expect((await call(message(text))).status, text).toBe(200);
        expect(reply(), text).toContain("expired or was already used");
      }
      expect((await subs())[0]?.verified_at).toBeNull();
    });

    it("tells a chat that is already linked so, without linking it twice", async () => {
      await call(message(`/start ${await newCode()}`));
      h.sendTelegram.mockClear();
      expect((await call(message(`/start ${await newCode()}`))).status).toBe(200);
      expect(reply()).toMatch(
        /^This chat already gets alerts for acme\.vaults\.probarion\.near\. /,
      );
      expect((await subs()).filter((s) => s.active)).toHaveLength(1);
    });

    it("answers 200 even when Telegram will not take the reply, and logs the reason without the chat or the text", async () => {
      h.sendTelegram.mockResolvedValue({
        ok: false,
        error: "Forbidden: bot was blocked by the user",
      });
      const res = await call(message(`/start ${await newCode()}`));
      expect(res.status).toBe(200);
      expect(
        logs.lines.some(
          (l) => l.includes("telegram.reply_failed") && l.includes("blocked by the user"),
        ),
      ).toBe(true);
      expect(logs.lines.join("\n")).not.toContain(String(CHAT));
      expect(logs.lines.join("\n")).not.toContain(TOKEN);
    });

    it("answers 200 when the link cannot be checked, and logs neither the chat nor the code", async () => {
      const code = await newCode();
      const real = h.db;
      h.db = {
        rpc: (fn: string, p?: Record<string, unknown>) =>
          fn === "alert_subscription_verify"
            ? Promise.reject(new Error("connection refused"))
            : real.rpc(fn, p),
      } as Db;
      try {
        const res = await call(message(`/start ${code}`));
        expect(res.status).toBe(200);
      } finally {
        h.db = real;
      }
      expect(h.sendTelegram).not.toHaveBeenCalled();
      const all = logs.lines.join("\n");
      expect(all).toContain("telegram.webhook_failed");
      expect(all).not.toContain(String(CHAT));
      expect(all).not.toContain(code);
    });
  });

  describe("/stop", () => {
    const link = async (t: string, chat: number) => {
      await call(message(`/start ${await newCode(t)}`, chat));
      h.sendTelegram.mockClear();
    };

    it("ends every alert of this chat and says how many vaults stopped", async () => {
      await link(tenant, CHAT);
      await link(other, CHAT);
      await link(tenant, 777);
      const res = await call(message("/stop"));
      expect(res.status).toBe(200);
      expect(reply()).toBe(
        "Stopped alerts for 2 vaults. Create a new link in the Probarion console to turn them on again.",
      );
      const left = await subs();
      expect(left.filter((s) => s.active).map((s) => s.target)).toEqual(["777"]);
    });

    it("says it in the singular for one vault, and says so when nothing was on", async () => {
      await link(tenant, CHAT);
      await call(message("/stop"));
      expect(reply()).toContain("Stopped alerts for 1 vault.");
      h.sendTelegram.mockClear();
      await call(message("/stop@ProbarionBot"));
      expect(reply()).toBe("No alerts were on for this chat.");
    });
  });

  describe("anything else", () => {
    it("answers 200 and does nothing for junk: not JSON, not an object, no message, other commands, other updates", async () => {
      const code = await newCode();
      const junk: unknown[] = [
        "{not json",
        "",
        "null",
        "42",
        {},
        { update_id: 1 },
        { edited_message: { chat: { id: 1 }, text: `/start ${code}` } },
        message("hello"),
        message("/help"),
        message("/start"),
        message("/start <script>alert(1)</script>"),
        message("/stop now"),
        { message: { chat: { id: {} }, text: "/stop" } },
      ];
      for (const body of junk) {
        const res = await call(body);
        expect(res.status, JSON.stringify(body)).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      }
      expect(h.sendTelegram).not.toHaveBeenCalled();
      expect((await subs())[0]?.verified_at).toBeNull();
    });
  });
});
