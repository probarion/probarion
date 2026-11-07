import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import { telegramWebhookSecret } from "./telegram";

export interface SetupIO {
  fetch: typeof fetch;
  out(line: string): void;
  err(line: string): void;
}

const DEFAULT_ORIGIN = "https://probarion.xyz";

/** One JSON line: Telegram's `ok` and `description`, and nothing else. */
const answer = (out: SetupIO["out"], ok: boolean, description: string) =>
  out(JSON.stringify({ ok, description }));

/**
 * The setup script's work (apps/web/scripts/telegram-webhook.ts, docs/ops/alerts.md): it calls Telegram's `setWebhook`
 * for this app's webhook route, with the secret the route expects (derived from KEY_ENCRYPTION_SECRET) and only
 * `message` updates. Run it once after the first deploy and again after a new KEY_ENCRYPTION_SECRET, which changes the
 * secret. It prints Telegram's `ok` and `description` and nothing else: never the token, the secret or the address.
 *
 * Reads TELEGRAM_BOT_TOKEN, KEY_ENCRYPTION_SECRET and APP_ORIGIN (default https://probarion.xyz). Exit code: 0 Telegram
 * set it, 1 Telegram refused or could not be reached, 2 an input is missing or wrong (the message names the variable,
 * never its value).
 */
export async function runWebhookSetup(
  env: Record<string, string | undefined>,
  io: SetupIO,
): Promise<number> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const master = env.KEY_ENCRYPTION_SECRET?.trim();
  const origin = (env.APP_ORIGIN?.trim() || DEFAULT_ORIGIN).replace(/\/+$/, "");
  if (!token) {
    io.err("TELEGRAM_BOT_TOKEN is required");
    return 2;
  }
  if (!master) {
    io.err("KEY_ENCRYPTION_SECRET is required");
    return 2;
  }
  // Telegram only calls an https address, and the route's address is the origin plus a fixed path.
  if (!/^https:\/\/[^/?#\s]+$/.test(origin)) {
    io.err("APP_ORIGIN must be an https address with no path, for example https://probarion.xyz");
    return 2;
  }
  let secret: string;
  try {
    secret = await telegramWebhookSecret(await deriveSubkey(parseMasterKey(master), "telegram"));
  } catch {
    io.err("KEY_ENCRYPTION_SECRET must be 32 bytes encoded as base64");
    return 2;
  }
  // Whatever Telegram says is cut of the token and the secret before it is printed.
  const scrub = (text: string) => text.split(token).join("[token]").split(secret).join("[secret]");
  let res: Response;
  try {
    res = await io.fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `${origin}/api/telegram/webhook`,
        secret_token: secret,
        allowed_updates: ["message"],
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    answer(io.out, false, "Telegram could not be reached");
    return 1;
  }
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    description?: string;
  } | null;
  const ok = body?.ok === true;
  answer(io.out, ok, scrub(String(body?.description ?? (ok ? "ok" : `HTTP ${res.status}`))));
  return ok ? 0 : 1;
}
