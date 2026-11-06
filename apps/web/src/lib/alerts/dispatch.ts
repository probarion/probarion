import type { Network } from "@/lib/config";
import type { Db } from "@/lib/db/port";
import { log } from "@/lib/log";
import type { EmailSender } from "./email";
import { providerError } from "./errors";
import { type AlertChannel, type AlertEvent, formatAlert } from "./format";
import type { StopLinks } from "./stop";
import type { SendResult } from "./telegram";

export interface Senders {
  telegram: ((chatId: string, text: string) => Promise<SendResult>) | null;
  email: EmailSender | null;
}

/** One alert waiting to go out: what `alerts_pending` (migration 0011) answers. */
interface Pending {
  subscription_id: string;
  vault_event_id: number;
  channel: AlertChannel;
  /** An email address or a Telegram chat id. Never logged. */
  target: string;
  vault_id: string;
  event: AlertEvent;
}

export interface DispatchDeps {
  db: Db;
  senders: Senders;
  network: Network;
  origin: string;
  /** The links in an email that stop its subscription (lib/alerts/stop.ts). */
  stopLinks: (subscriptionId: string) => Promise<StopLinks>;
  /** How many alerts one run looks at. */
  limit?: number;
  /** Epoch milliseconds. No new alert is claimed from then on; what is left waits for the next run. */
  deadline?: number;
  now?: () => number;
  /** How long one send may take before it counts as failed. A claim is never held longer than that by a hung call. */
  sendTimeoutMs?: number;
}

export interface DispatchResult {
  sent: number;
  failed: number;
  /** Alerts for a channel that has no sender here (no token or key in this deployment): not claimed, tried next run. */
  skipped: number;
  /** Alerts the deadline left for the next run. */
  deferred: number;
}

async function sendWithin(send: () => Promise<SendResult>, ms: number): Promise<SendResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<SendResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), ms);
  });
  try {
    return await Promise.race([send(), late]);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends what `alerts_pending` lists, once per (subscription, event). The only way to a send is `alert_claim`: a row of
 * `alerts_sent` that is unique on that pair, so two runs that overlap cannot both send. A failed send is tried again on a
 * later run, three attempts in all; a claim left `sending` by a run that died is taken again after 2 minutes, and an email
 * carries a Resend idempotency key, so that path cannot send an email twice. A Telegram send that timed out may have
 * gone out, so in that rare case a message can arrive twice.
 *
 * A claim is made right before its send. After `deadline` nothing more is claimed. The logs name the channel and the ids,
 * never an address, a chat id or message text.
 */
export async function dispatchAlerts(deps: DispatchDeps): Promise<DispatchResult> {
  const now = deps.now ?? Date.now;
  const pending = await deps.db.rpc<Pending[]>("alerts_pending", {
    network: deps.network,
    limit: deps.limit ?? 200,
  });
  const result: DispatchResult = { sent: 0, failed: 0, skipped: 0, deferred: 0 };
  let late = false;
  for (const p of pending) {
    const telegram = deps.senders.telegram;
    const email = deps.senders.email;
    if ((p.channel === "telegram" && !telegram) || (p.channel === "email" && !email)) {
      result.skipped++;
      continue;
    }
    if (late || (deps.deadline !== undefined && now() >= deps.deadline)) {
      late = true;
      result.deferred++;
      continue;
    }
    const ids = {
      subscription_id: p.subscription_id,
      event_id: p.vault_event_id,
      channel: p.channel,
    };
    let links: StopLinks | null = null;
    if (p.channel === "email") {
      try {
        links = await deps.stopLinks(p.subscription_id);
      } catch (error) {
        // Before the claim: a missing key is the deployment's fault, and it must not use up the alert's attempts.
        result.failed++;
        log.error("alerts.stop_links_failed", { ...ids, error });
        continue;
      }
    }
    const claim = await deps.db.rpc<{
      claimed: boolean;
      id: number | null;
      attempt: number | null;
    }>("alert_claim", { subscription_id: p.subscription_id, vault_event_id: p.vault_event_id });
    if (!claim.claimed || claim.id === null || claim.attempt === null) continue;
    const msg = formatAlert(p.event, p.vault_id, deps.network, deps.origin, p.channel, links?.page);
    const r = await sendWithin(
      () =>
        p.channel === "telegram" && telegram
          ? telegram(p.target, `${msg.subject}\n\n${msg.text}`)
          : email && links
            ? email.send({
                to: p.target,
                subject: msg.subject,
                text: msg.text,
                idempotencyKey: `alert-${p.subscription_id}-${p.vault_event_id}`,
                unsubscribeUrl: links.oneClick,
              })
            : Promise.resolve<SendResult>({ ok: false, error: "no sender" }),
      deps.sendTimeoutMs ?? 12_000,
    );
    const error = r.ok ? null : providerError(r.error, p.target);
    await markClaim(
      deps.db,
      {
        id: claim.id,
        attempt: claim.attempt,
        status: r.ok ? "sent" : "failed",
        provider_id: r.ok ? r.id : null,
        error,
      },
      ids,
    );
    if (r.ok) result.sent++;
    else {
      result.failed++;
      log.warn("alerts.send_failed", { ...ids, error });
    }
  }
  return result;
}

/** One retry: the send has happened, and a mark that is lost leaves the claim `sending` for 2 minutes, then a second send. */
async function markClaim(
  db: Db,
  mark: Record<string, unknown>,
  ids: Record<string, unknown>,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await db.rpc("alert_mark", mark);
      return;
    } catch (error) {
      if (attempt === 2) log.error("alerts.mark_failed", { ...ids, error });
    }
  }
}
