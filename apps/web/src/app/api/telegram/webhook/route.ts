import { timingSafeEqual } from "node:crypto";
import { kindsInWords } from "@/lib/alerts/kinds";
import {
  parseStartCommand,
  parseStopCommand,
  sendTelegram,
  telegramWebhookSecret,
} from "@/lib/alerts/telegram";
import { subkey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import { DbError } from "@/lib/db/port";
import { getEnv } from "@/lib/env";
import { json, problem, rateLimitOr429 } from "@/lib/http";
import { log } from "@/lib/log";
import { originFor } from "@/lib/network";
import { LIMITS } from "@/lib/ratelimit";
import { isNetwork } from "@/lib/site/network";

export const dynamic = "force-dynamic";

interface Linked {
  vault_id: string;
  /** The vault's network (migration 0012). One bot serves both networks, so the reply names the right console. */
  network?: unknown;
  kinds: string[];
  duplicate: boolean;
}

/** The alerts page of the vault on its own network's address, or null when that network is not served by this site. */
function consoleLink(linked: Linked): string | null {
  if (!isNetwork(linked.network)) return null;
  try {
    const origin = originFor(linked.network);
    return origin === null
      ? null
      : `${origin}/console/${encodeURIComponent(linked.vault_id)}/alerts`;
  } catch {
    return null;
  }
}

const EXPIRED =
  "That link has expired or was already used. Create a new one in the Probarion console.";

async function reply(token: string, chatId: string, text: string): Promise<void> {
  const sent = await sendTelegram(token, chatId, text);
  // Telegram's own reason ("bot was blocked by the user"), never the chat or the text.
  if (!sent.ok) log.warn("telegram.reply_failed", { error: sent.error.slice(0, 200) });
}

/**
 * Telegram's webhook (docs/ops/alerts.md): the owner opens the t.me/<bot>?start=<code> link from the console, and
 * Telegram sends `/start <code>` here. `/stop` ends every alert of the chat. The call must carry the secret that
 * setWebhook was given (derived from the `telegram` subkey, so a rotation of the master key needs the setup script
 * again); a wrong one is a 401 before anything is read, and it is compared in constant time. Past that the answer is
 * always 200, so Telegram does not retry an update this route has understood: a link that is not good, a reply Telegram
 * will not take and a database that fails are logged (no chat id, no code, no text) and answered 200.
 */
export async function POST(req: Request) {
  let token: string | null;
  try {
    token = getEnv().TELEGRAM_BOT_TOKEN;
  } catch {
    return problem(503, "unavailable");
  }
  if (!token) return problem(503, "not_configured");
  try {
    const want = Buffer.from(await telegramWebhookSecret(await subkey("telegram")));
    const got = Buffer.from(req.headers.get("x-telegram-bot-api-secret-token") ?? "");
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      return problem(401, "unauthorized");
    }
    const limited = await rateLimitOr429(serviceDb(), "telegram:webhook", LIMITS.telegramWebhook);
    if (limited) return limited;
  } catch (error) {
    // The key or the limiter's database: a status Telegram retries, not a 200 that drops the update.
    log.error("telegram.webhook_unavailable", { error });
    return problem(503, "unavailable");
  }

  const update = await req.json().catch(() => null);
  const start = parseStartCommand(update);
  const stop = start ? null : parseStopCommand(update);
  try {
    if (start) {
      const linked = await serviceDb().rpc<Linked | null>("alert_subscription_verify", {
        channel: "telegram",
        link_code: start.code,
        target: start.chatId,
      });
      await reply(
        token,
        start.chatId,
        linked === null
          ? EXPIRED
          : `${linked.duplicate ? `This chat already gets alerts for ${linked.vault_id}.` : `Linked to ${linked.vault_id}.`} You will get a message when ${kindsInWords(linked.kinds)}. Send /stop to end alerts.${consoleLink(linked) === null ? "" : `\n\nManage them: ${consoleLink(linked)}`}`,
      );
    } else if (stop) {
      const { stopped } = await serviceDb().rpc<{ stopped: number }>("alert_telegram_stop", {
        chat_id: stop.chatId,
      });
      await reply(
        token,
        stop.chatId,
        stopped === 0
          ? "No alerts were on for this chat."
          : `Stopped alerts for ${stopped} vault${stopped === 1 ? "" : "s"}. Create a new link in the Probarion console to turn them on again.`,
      );
    }
  } catch (error) {
    log.warn("telegram.webhook_failed", {
      error: error instanceof DbError ? error.code : "failed",
    });
  }
  return json({ ok: true });
}
