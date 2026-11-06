import { describe, expect, it, vi } from "vitest";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import { telegramWebhookSecret } from "./telegram";
import { runWebhookSetup } from "./webhook-setup";

// Masters and tokens are built at run time: no high-entropy literal in the repo (gitleaks scans history).
const MASTER_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 5 + 1) % 256)).toString(
  "base64",
);
const TOKEN = `123456789:AAH${"q".repeat(32)}`;
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, KEY_ENCRYPTION_SECRET: MASTER_B64 };

function io(
  answer: () => Promise<Response> = async () =>
    new Response(JSON.stringify({ ok: true, result: true, description: "Webhook was set" })),
) {
  const out: string[] = [];
  const err: string[] = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => answer());
  return {
    out,
    err,
    fetchImpl,
    deps: {
      fetch: fetchImpl as unknown as typeof fetch,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
    },
  };
}
const secretFor = async () =>
  telegramWebhookSecret(await deriveSubkey(parseMasterKey(MASTER_B64), "telegram"));

describe("runWebhookSetup", () => {
  it("calls setWebhook itself, with the app's webhook address, the derived secret and only message updates", async () => {
    const t = io();
    expect(await runWebhookSetup(ENV, t.deps)).toBe(0);
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = t.fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(`https://api.telegram.org/bot${TOKEN}/setWebhook`);
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      url: "https://probarion.xyz/api/telegram/webhook",
      secret_token: await secretFor(),
      allowed_updates: ["message"],
    });
  });

  it("uses APP_ORIGIN when it is set, without a trailing slash", async () => {
    for (const origin of ["https://probarion.vercel.app", "https://probarion.vercel.app/"]) {
      const t = io();
      await runWebhookSetup({ ...ENV, APP_ORIGIN: origin }, t.deps);
      expect(JSON.parse(String(t.fetchImpl.mock.calls[0]?.[1]?.body)).url).toBe(
        "https://probarion.vercel.app/api/telegram/webhook",
      );
    }
  });

  it("prints Telegram's ok and description, and nothing else: not the token, not the secret, not the address", async () => {
    const t = io();
    await runWebhookSetup(ENV, t.deps);
    expect(t.out).toEqual([JSON.stringify({ ok: true, description: "Webhook was set" })]);
    expect(t.err).toEqual([]);
    const all = [...t.out, ...t.err].join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(await secretFor());
    expect(all).not.toContain("probarion.xyz");
  });

  it("exits 1 and prints Telegram's reason when it refuses, still without the token or the secret", async () => {
    const t = io(
      async () =>
        new Response(
          JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized ${TOKEN}` }),
          { status: 401 },
        ),
    );
    expect(await runWebhookSetup(ENV, t.deps)).toBe(1);
    expect(t.out).toEqual([JSON.stringify({ ok: false, description: "Unauthorized [token]" })]);
    expect([...t.out, ...t.err].join("\n")).not.toContain(TOKEN);
  });

  it("exits 1 with a plain description when Telegram cannot be reached or answers something that is not JSON", async () => {
    const down = io(async () => {
      throw new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/setWebhook`);
    });
    expect(await runWebhookSetup(ENV, down.deps)).toBe(1);
    expect(down.out).toEqual([
      JSON.stringify({ ok: false, description: "Telegram could not be reached" }),
    ]);
    const html = io(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await runWebhookSetup(ENV, html.deps)).toBe(1);
    expect(html.out).toEqual([JSON.stringify({ ok: false, description: "HTTP 502" })]);
    expect([...down.out, ...down.err, ...html.out].join("\n")).not.toContain(TOKEN);
  });

  it("exits 2 and calls nothing when an input is missing or wrong, naming the variable and never its value", async () => {
    const cases: [Record<string, string | undefined>, string][] = [
      [{ KEY_ENCRYPTION_SECRET: MASTER_B64 }, "TELEGRAM_BOT_TOKEN"],
      [{ ...ENV, TELEGRAM_BOT_TOKEN: "  " }, "TELEGRAM_BOT_TOKEN"],
      [{ TELEGRAM_BOT_TOKEN: TOKEN }, "KEY_ENCRYPTION_SECRET"],
      [{ ...ENV, KEY_ENCRYPTION_SECRET: "not base64 of 32 bytes" }, "KEY_ENCRYPTION_SECRET"],
      [{ ...ENV, APP_ORIGIN: "http://probarion.xyz" }, "APP_ORIGIN"],
      [{ ...ENV, APP_ORIGIN: "probarion.xyz" }, "APP_ORIGIN"],
      [{ ...ENV, APP_ORIGIN: "https://probarion.xyz/path" }, "APP_ORIGIN"],
    ];
    for (const [env, name] of cases) {
      const t = io();
      expect(await runWebhookSetup(env, t.deps), name).toBe(2);
      expect(t.fetchImpl).not.toHaveBeenCalled();
      const said = [...t.out, ...t.err].join("\n");
      expect(said).toContain(name);
      expect(said).not.toContain(TOKEN);
      expect(said).not.toContain(MASTER_B64);
      expect(said).not.toContain("not base64 of 32 bytes");
    }
  });
});
