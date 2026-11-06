import { keyedHashHex } from "@/lib/crypto/sodium";

export type SendResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Plain text, no `parse_mode`: nothing in a message is read as markup, so there is nothing to escape. A failure is
 * answered as words, never as the thrown error: a fetch error can quote the request's URL, and that URL holds the token.
 */
export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network error",
    };
  }
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: { message_id?: number };
    description?: string;
  } | null;
  return body?.ok
    ? { ok: true, id: String(body.result?.message_id ?? "") }
    : { ok: false, error: body?.description ?? `HTTP ${res.status}` };
}

let username: string | null = null;

/** The bot's @name, read once per process (getMe) and kept. A failure is null and is not kept. */
export async function telegramBotUsername(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (username) return username;
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { username?: string };
    } | null;
    username = body?.ok ? (body.result?.username ?? null) : null;
  } catch {
    username = null;
  }
  return username;
}

/** The chat a message came from, when the update is a message with a numeric or string chat id. */
function chatOf(update: unknown): { chatId: string; text: string } | null {
  if (typeof update !== "object" || update === null) return null;
  const msg = (update as { message?: { chat?: { id?: unknown }; text?: unknown } }).message;
  if (typeof msg?.text !== "string") return null;
  const id = msg.chat?.id;
  if (typeof id !== "number" && typeof id !== "string") return null;
  return { chatId: String(id), text: msg.text.trim() };
}

/** The deep link t.me/<bot>?start=<code> arrives as "/start <code>" (a payload of at most 64 characters of A-Za-z0-9_-). */
export function parseStartCommand(update: unknown): { chatId: string; code: string } | null {
  const m = chatOf(update);
  const start = m === null ? null : /^\/start\s+([A-Za-z0-9_-]{8,64})$/.exec(m.text);
  return m !== null && start ? { chatId: m.chatId, code: start[1] as string } : null;
}

/** "/stop", or "/stop@TheBot" as a group sends it. */
export function parseStopCommand(update: unknown): { chatId: string } | null {
  const m = chatOf(update);
  return m !== null && /^\/stop(@[A-Za-z0-9_]{1,64})?$/.test(m.text) ? { chatId: m.chatId } : null;
}

/** setWebhook's secret_token is 1 to 256 characters of A-Za-z0-9_-. It is derived, so there is no variable to keep. */
export function telegramWebhookSecret(telegramSubkey: Uint8Array): Promise<string> {
  return keyedHashHex(telegramSubkey, "telegram-webhook");
}
