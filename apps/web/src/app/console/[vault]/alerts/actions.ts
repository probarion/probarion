"use server";

import { revalidatePath } from "next/cache";
import { providerError } from "@/lib/alerts/errors";
import { alertSenders } from "@/lib/alerts/server";
import { telegramBotUsername } from "@/lib/alerts/telegram";
import { appOrigin } from "@/lib/config";
import { isDenied, memberForAction } from "@/lib/console/action-auth";
import { serviceDb } from "@/lib/db/clients";
import { DbError } from "@/lib/db/port";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { LIMITS, takeToken } from "@/lib/ratelimit";

// `vault` is bound by the page, but a bound argument comes back from the browser, so it is only a lookup key: the tenant
// and the role come from the membership row (memberForAction), never from the form. Only an owner or an approver may
// add or remove an alert; a viewer may see the page. Errors are plain sentences: an exception's text never reaches the
// browser, and no log line holds an address, a chat id or a link code.

/** What the add-email form shows after a submit. */
export type AlertsState =
  | null
  | { ok: true; message: string }
  | { ok: false; error: string; status?: 401 | 403 };

/** What the Telegram button shows: the link to open, or why there is none. */
export type TelegramState =
  | { ok: true; link: string }
  | { ok: false; error: string; status?: 401 | 403 };

const CAN_CHANGE = ["owner", "approver"] as ("owner" | "approver")[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The table's own shape (alert_email_shape in migration 0001), and the longest an address can be (RFC 5321). */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_MAX = 254;
/** A Telegram bot's username: 5 to 32 letters, digits and underscores. It goes into a link, so nothing else does. */
const BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/;

const ERROR_TEXT = {
  email: "That does not look like an email address.",
  noMail: "Email alerts are not set up on this server.",
  noBot: "Telegram alerts are not set up on this server.",
  tooManyEmails: "Too many confirmation emails for this vault. Try again in a few minutes.",
  tooManyLinks: "Too many links for this vault. Try again in a few minutes.",
  full: "This vault already has 20 alerts. Remove one first.",
  failed: "The alert could not be added. Try again in a minute.",
  notSent: "The confirmation email could not be sent. Try again in a few minutes.",
} as const;

/** One budget for the vault's new alerts, emails and Telegram links together (`LIMITS.alertTest`). */
async function withinBudget(tenantId: string): Promise<boolean> {
  const [max, windowSeconds] = LIMITS.alertTest;
  return (await takeToken(serviceDb(), `alerts:add:${tenantId}`, max, windowSeconds)).allowed;
}

/** The sentence for a failed `alert_subscription_create`. */
function createFailure(error: unknown, tenant: string): string {
  if (error instanceof DbError && error.code === "limit_reached") return ERROR_TEXT.full;
  log.warn("alerts.create_failed", {
    tenant,
    error: error instanceof DbError ? error.code : "failed",
  });
  return ERROR_TEXT.failed;
}

/**
 * Owner or approver. Makes an email alert that is not on yet, and sends the address a link that opens
 * /alerts/confirm (a page with a button: a mail scanner that opens the link turns nothing on). The link works once and for
 * 24 hours. If the email cannot be sent the alert is switched off again, so no dead row is left.
 */
export async function addEmailAction(
  vault: string,
  _prev: AlertsState,
  formData: FormData,
): Promise<AlertsState> {
  const auth = await memberForAction(vault, CAN_CHANGE);
  if (isDenied(auth)) return { ok: false, ...auth };
  const { member, session } = auth;
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (email.length > EMAIL_MAX || !EMAIL.test(email)) return { ok: false, error: ERROR_TEXT.email };
  const sender = alertSenders().email;
  if (sender === null) return { ok: false, error: ERROR_TEXT.noMail };
  let created: { id: string; link_code: string };
  try {
    if (!(await withinBudget(member.tenant_id)))
      return { ok: false, error: ERROR_TEXT.tooManyEmails };
    created = await serviceDb().rpc("alert_subscription_create", {
      tenant_id: member.tenant_id,
      channel: "email",
      target: email,
      created_by: session.accountId,
    });
  } catch (error) {
    return { ok: false, error: createFailure(error, member.tenant_id) };
  }
  const sent = await sender
    .send({
      to: email,
      subject: `[Probarion] Confirm alerts for ${member.vault_id}`,
      text: [
        `Confirm that this address should get payment alerts for ${member.vault_id}:`,
        `${appOrigin()}/alerts/confirm?code=${created.link_code}`,
        "",
        "The link works once and for 24 hours. Opening it shows a button; nothing is turned on until you press it.",
        "If you did not ask for this, ignore this email.",
      ].join("\n"),
      idempotencyKey: `verify-${created.link_code}`,
    })
    .catch(() => ({ ok: false as const, error: "send failed" }));
  if (!sent.ok) {
    log.warn("alerts.confirmation_failed", {
      tenant: member.tenant_id,
      subscription: created.id,
      error: providerError(sent.error, email),
    });
    await serviceDb()
      .rpc("alert_subscription_deactivate", { tenant_id: member.tenant_id, id: created.id })
      .catch(() => undefined);
    return { ok: false, error: ERROR_TEXT.notSent };
  }
  revalidatePath(`/console/${member.vault_id}/alerts`);
  return {
    ok: true,
    message: `Confirmation sent to ${email}. Open the link in it within 24 hours.`,
  };
}

/**
 * Owner or approver. Makes a Telegram alert that is not linked yet and answers the `t.me/<bot>?start=<code>` link. The
 * person opens it and presses Start; the bot's webhook (/api/telegram/webhook) links the chat. The code works once and for
 * 24 hours.
 */
export async function connectTelegramAction(vault: string): Promise<TelegramState> {
  const auth = await memberForAction(vault, CAN_CHANGE);
  if (isDenied(auth)) return { ok: false, ...auth };
  const { member, session } = auth;
  try {
    const token = getEnv().TELEGRAM_BOT_TOKEN;
    const bot = token ? await telegramBotUsername(token) : null;
    if (bot === null || !BOT_USERNAME.test(bot)) return { ok: false, error: ERROR_TEXT.noBot };
    if (!(await withinBudget(member.tenant_id)))
      return { ok: false, error: ERROR_TEXT.tooManyLinks };
    const created = await serviceDb().rpc<{ link_code: string }>("alert_subscription_create", {
      tenant_id: member.tenant_id,
      channel: "telegram",
      created_by: session.accountId,
    });
    revalidatePath(`/console/${member.vault_id}/alerts`);
    return { ok: true, link: `https://t.me/${bot}?start=${created.link_code}` };
  } catch (error) {
    return { ok: false, error: createFailure(error, member.tenant_id) };
  }
}

/** Owner or approver. Switches an alert off. Only an alert of the member's own vault; an id that is not a UUID is dropped unread. */
export async function removeSubscriptionAction(
  vault: string,
  id: string,
  _formData?: FormData,
): Promise<void> {
  const auth = await memberForAction(vault, CAN_CHANGE);
  if (isDenied(auth) || !UUID.test(id)) return;
  const { member } = auth;
  try {
    await serviceDb().rpc("alert_subscription_deactivate", { tenant_id: member.tenant_id, id });
  } catch (error) {
    log.warn("alerts.remove_failed", {
      tenant: member.tenant_id,
      error: error instanceof DbError ? error.code : "failed",
    });
  }
  revalidatePath(`/console/${member.vault_id}/alerts`);
}
