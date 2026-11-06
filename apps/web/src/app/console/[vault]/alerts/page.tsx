import type { Metadata } from "next";
import { AddEmailForm } from "@/components/console/AddEmailForm";
import { TelegramConnect } from "@/components/console/TelegramConnect";
import { VaultNav } from "@/components/console/VaultNav";
import { Badge, Card, Notice } from "@/components/ui";
import { kindsInWords } from "@/lib/alerts/kinds";
import { requireMember } from "@/lib/auth/guard";
import { serviceDb } from "@/lib/db/clients";
import { addEmailAction, connectTelegramAction, removeSubscriptionAction } from "./actions";

export const metadata: Metadata = { title: "Alerts" };

const muted = "text-[#0B0B0C]/60";

/** One entry of `alert_subscriptions_list` (migration 0011). It never has a link code. */
interface Sub {
  id: string;
  channel: "email" | "telegram";
  target: string | null;
  kinds: string[];
  verified_at: string | null;
}

export default async function AlertsPage({
  params,
  searchParams,
}: {
  params: Promise<{ vault: string }>;
  searchParams: Promise<{ verified?: string }>;
}) {
  const { vault: requested } = await params;
  const { verified } = await searchParams;
  // 404 for anyone who is not a member: a vault id is never confirmed to a stranger.
  const { member } = await requireMember(requested);
  const vault = member.vault_id;
  // Owners and approvers change alerts; a viewer sees them (the actions check the role again).
  const canChange = member.role === "owner" || member.role === "approver";
  let subs: Sub[] | null;
  try {
    subs = await serviceDb().rpc<Sub[]>("alert_subscriptions_list", {
      tenant_id: member.tenant_id,
    });
  } catch {
    subs = null;
  }
  const kinds = [...new Set((subs ?? []).flatMap((s) => s.kinds))];

  return (
    <div>
      <h1 className="mono mb-1 text-2xl font-semibold break-all">{vault}</h1>
      <p className={`mb-4 text-sm ${muted}`}>Alerts · you are {member.role}</p>
      <VaultNav vault={vault} />
      {verified === "1" ? <Notice tone="good">Email confirmed. Alerts are on.</Notice> : null}
      <Notice>
        A message goes out when the watcher records an event on this vault that an alert is set for
        (the kinds are listed under Active alerts). The watcher checks a vault right after an
        invoice upload, once a day, and every minute once its schedule is on, so a change made only
        on the chain can wait for the next check.
      </Notice>
      {canChange ? null : (
        <Notice>Only the vault&apos;s owners and approvers can add or remove alerts.</Notice>
      )}
      <Card title="Active alerts">
        {subs === null ? (
          <Notice tone="bad">The alerts could not be read right now. Try again in a minute.</Notice>
        ) : subs.length === 0 ? (
          <p className={`text-sm ${muted}`}>
            No alerts yet.{canChange ? " Add an email address or a Telegram chat below." : ""}
          </p>
        ) : (
          <>
            <ul className="text-sm">
              {subs.map((s) => (
                <li key={s.id} className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge>{s.channel === "email" ? "email" : "Telegram"}</Badge>
                  {s.target === null ? (
                    <span className={muted}>Telegram link not used yet</span>
                  ) : (
                    <span className="mono break-all">
                      {s.channel === "telegram" ? `chat ${s.target}` : s.target}
                    </span>
                  )}
                  {s.verified_at ? (
                    <Badge tone="good">on</Badge>
                  ) : (
                    <Badge tone="warn">waiting for confirmation</Badge>
                  )}
                  {canChange ? (
                    <form action={removeSubscriptionAction.bind(null, vault, s.id)}>
                      <button type="submit" className="text-xs text-stone-600 underline">
                        Remove
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className={`mt-2 text-xs ${muted}`}>
              Each alert sends a message when {kindsInWords(kinds)}.
            </p>
          </>
        )}
      </Card>
      {canChange ? (
        <>
          <Card title="Add email">
            <AddEmailForm add={addEmailAction.bind(null, vault)} />
            <p className={`mt-2 text-xs ${muted}`}>
              We send a link to confirm the address. The link in it works for 24 hours, and every
              alert email has a stop link that needs no sign-in.
            </p>
          </Card>
          <Card title="Add Telegram">
            <TelegramConnect connect={connectTelegramAction.bind(null, vault)} />
            <p className={`mt-2 text-xs ${muted}`}>
              The link works once, for 24 hours. Send /stop to the bot to end alerts.
            </p>
          </Card>
        </>
      ) : null}
    </div>
  );
}
