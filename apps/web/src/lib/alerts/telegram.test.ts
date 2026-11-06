import { describe, expect, it, vi } from "vitest";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import {
  parseStartCommand,
  parseStopCommand,
  sendTelegram,
  telegramBotUsername,
  telegramWebhookSecret,
} from "./telegram";

const TOKEN = `123456789:AAH${"x".repeat(32)}`;
const CODE = "0123456789abcdef0123456789abcdef";

describe("telegram", () => {
  describe("parseStartCommand", () => {
    it("parses /start <code> from a message update", () => {
      expect(
        parseStartCommand({
          update_id: 1,
          message: { chat: { id: 4242 }, text: "/start abcDEF123456" },
        }),
      ).toEqual({ chatId: "4242", code: "abcDEF123456" });
      expect(
        parseStartCommand({ message: { chat: { id: "-100123" }, text: ` /start ${CODE} ` } }),
      ).toEqual({
        chatId: "-100123",
        code: CODE,
      });
    });

    it("refuses a missing, malformed or hostile payload", () => {
      expect(parseStartCommand({ message: { chat: { id: 1 }, text: "/start" } })).toBeNull();
      expect(
        parseStartCommand({ message: { chat: { id: 1 }, text: "/start <script>" } }),
      ).toBeNull();
      expect(parseStartCommand({ message: { chat: { id: 1 }, text: "/start short" } })).toBeNull();
      expect(
        parseStartCommand({ message: { chat: { id: 1 }, text: `/start ${"a".repeat(65)}` } }),
      ).toBeNull();
      expect(
        parseStartCommand({ message: { chat: { id: 1 }, text: `/start ${CODE} extra` } }),
      ).toBeNull();
      expect(parseStartCommand({ message: { chat: {}, text: `/start ${CODE}` } })).toBeNull();
      expect(
        parseStartCommand({ message: { chat: { id: {} }, text: `/start ${CODE}` } }),
      ).toBeNull();
      expect(parseStartCommand({ message: { chat: { id: 1 }, text: 5 } })).toBeNull();
      expect(
        parseStartCommand({ edited_message: { chat: { id: 1 }, text: `/start ${CODE}` } }),
      ).toBeNull();
      expect(parseStartCommand("nope")).toBeNull();
      expect(parseStartCommand(null)).toBeNull();
      expect(parseStartCommand(undefined)).toBeNull();
    });
  });

  describe("parseStopCommand", () => {
    it("reads /stop from a chat, with or without the bot's name, and returns the chat", () => {
      expect(parseStopCommand({ message: { chat: { id: 4242 }, text: "/stop" } })).toEqual({
        chatId: "4242",
      });
      expect(
        parseStopCommand({ message: { chat: { id: -9 }, text: " /stop@ProbarionBot " } }),
      ).toEqual({
        chatId: "-9",
      });
    });

    it("refuses anything else", () => {
      for (const text of ["/stop now", "stop", "/stopp", "/start", "/stop@", "x/stop", ""]) {
        expect(parseStopCommand({ message: { chat: { id: 1 }, text } }), text).toBeNull();
      }
      expect(parseStopCommand({ message: { chat: {}, text: "/stop" } })).toBeNull();
      expect(parseStopCommand("nope")).toBeNull();
      expect(parseStopCommand(null)).toBeNull();
    });
  });

  describe("sendTelegram", () => {
    it("sends plain text with link previews disabled and no parse mode", async () => {
      let body: Record<string, unknown> = {};
      let url = "";
      const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
        url = String(u);
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }));
      }) as typeof fetch;
      expect(await sendTelegram("T", "4242", "hi", f)).toEqual({ ok: true, id: "77" });
      expect(body).toEqual({
        chat_id: "4242",
        text: "hi",
        link_preview_options: { is_disabled: true },
      });
      expect(body).not.toHaveProperty("parse_mode");
      expect(url).toBe("https://api.telegram.org/botT/sendMessage");
    });

    it("answers Telegram's own reason when it refuses, and the status when it says nothing", async () => {
      const refuse = (async () =>
        new Response(
          JSON.stringify({ ok: false, description: "Forbidden: bot was blocked by the user" }),
          {
            status: 403,
          },
        )) as typeof fetch;
      expect(await sendTelegram("T", "1", "x", refuse)).toEqual({
        ok: false,
        error: "Forbidden: bot was blocked by the user",
      });
      const html = (async () =>
        new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
      expect(await sendTelegram("T", "1", "x", html)).toEqual({ ok: false, error: "HTTP 502" });
    });

    it("turns a network failure into an error that holds neither the token nor the address", async () => {
      const down = (async () => {
        throw new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`);
      }) as typeof fetch;
      const r = await sendTelegram(TOKEN, "1", "x", down);
      expect(r).toEqual({ ok: false, error: "network error" });
      const slow = (async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as typeof fetch;
      expect(await sendTelegram(TOKEN, "1", "x", slow)).toEqual({ ok: false, error: "timeout" });
    });
  });

  describe("telegramBotUsername", () => {
    it("reads the bot's name once and keeps it, and never keeps a failure", async () => {
      const down = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 401 }));
      expect(await telegramBotUsername("T", down as unknown as typeof fetch)).toBeNull();
      const up = vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, result: { username: "ProbarionBot" } })),
      );
      expect(await telegramBotUsername("T", up as unknown as typeof fetch)).toBe("ProbarionBot");
      expect(await telegramBotUsername("T", up as unknown as typeof fetch)).toBe("ProbarionBot");
      expect(up).toHaveBeenCalledTimes(1);
      expect(String(up.mock.calls[0])).toContain("https://api.telegram.org/botT/getMe");
    });

    it("is null, not an error, when Telegram cannot be reached", async () => {
      // A fresh module: the name above is cached.
      vi.resetModules();
      const { telegramBotUsername: fresh } = await import("./telegram");
      const down = (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch;
      expect(await fresh("T", down)).toBeNull();
    });
  });

  describe("telegramWebhookSecret", () => {
    it("is a setWebhook secret_token: 1 to 256 characters of A-Za-z0-9_-, one per key", async () => {
      const a = await deriveSubkey(
        parseMasterKey(Buffer.alloc(32, 1).toString("base64")),
        "telegram",
      );
      const b = await deriveSubkey(
        parseMasterKey(Buffer.alloc(32, 2).toString("base64")),
        "telegram",
      );
      const s = await telegramWebhookSecret(a);
      expect(s).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
      expect(await telegramWebhookSecret(a)).toBe(s);
      expect(await telegramWebhookSecret(b)).not.toBe(s);
    });
  });
});
