import "server-only";
import type { MandateView, Payee, SpendView } from "@probarion/core";
import type { Network } from "@/lib/config";
import { heldActions } from "@/lib/console/display";
import { mandateState, remainingUnits, usdcText } from "@/lib/console/mandates-view";
import type { Db } from "@/lib/db/port";
import { type MemberRole, memberTenants } from "@/lib/db/tenants";
import { log } from "@/lib/log";
import { nsToDate } from "@/lib/near/units";
import { payeeText } from "@/lib/payables/confirm-message";
import { listInvoices } from "@/lib/payables/store";
import { safeText } from "@/lib/proof/sanitize";

// What the extension's popup and badge show (spec §4.3): for each vault the account owns or approves on this network, the
// invoices waiting for the owner (owners only), the held payments an approver can still approve, and the mandates an
// invoice can still be sent under. Free text (names, refs, labels) passes safeText; payees and vaults are validated
// ids. Every link is a console page at this network's address.

export const MAX_VAULTS = 10;
export const MAX_ROWS = 10;

export interface InboxChain {
  mandates(vault: string): Promise<MandateView[]>;
  spends(vault: string): Promise<SpendView[]>;
}

export interface InboxInvoice {
  id: string;
  ref: string;
  amount: string;
  /** The mandate's payee, or null when the chain could not be read. */
  payee: string | null;
  created_at: string;
  url: string;
  /** Where the invoice came from (migration 0014): the console upload, or the browser extension. */
  source: "console" | "extension";
}

export interface InboxHeld {
  spend_id: number;
  amount: string;
  payee: string;
  held_until: string | null;
  url: string;
}

export interface InboxMandate {
  id: number;
  label: string;
  payee: string;
  per_payment: string;
  remaining: string;
  expires_at: string;
}

export interface InboxVault {
  vault: string;
  name: string;
  role: Extract<MemberRole, "owner" | "approver">;
  chain: "ok" | "unavailable";
  awaiting: InboxInvoice[];
  held: InboxHeld[];
  mandates: InboxMandate[];
}

export interface Inbox {
  network: Network;
  account: string;
  counts: { awaiting: number; held: number };
  vaults: InboxVault[];
}

function payeeOrNull(p: Payee): string | null {
  try {
    return payeeText(p);
  } catch {
    return null;
  }
}

function isoOrNull(ns: string | null): string | null {
  if (ns === null) return null;
  try {
    return nsToDate(ns).toISOString();
  } catch {
    return null;
  }
}

/**
 * What is left of a mandate an invoice can still be sent under (spec §4.4): active and unexpired, with a use left and
 * a readable total that is not used up. Null for any other mandate, which the queue (plan 06 Task E1b) refuses.
 */
function usableRemaining(m: MandateView, nowMs: number): string | null {
  if (mandateState(m, nowMs).key !== "active") return null;
  if (typeof m.uses !== "number" || typeof m.max_uses !== "number" || m.uses >= m.max_uses) {
    return null;
  }
  const left = remainingUnits(m);
  return left === null || left === "0" ? null : left;
}

export async function loadInbox(
  deps: { db: Db; chain: InboxChain; origin: string; now: Date },
  a: { account: string; network: Network },
): Promise<Inbox> {
  const nowMs = deps.now.getTime();
  const tenants = (await memberTenants(deps.db, a.account))
    .filter(
      (t) =>
        t.network === a.network &&
        t.kind !== "canary" &&
        (t.role === "owner" || t.role === "approver"),
    )
    .slice(0, MAX_VAULTS);
  const counts = { awaiting: 0, held: 0 };
  const vaults = await Promise.all(
    tenants.map(async (t): Promise<InboxVault> => {
      const base = `${deps.origin}/console/${encodeURIComponent(t.vault_id)}`;
      const [rows, chain] = await Promise.all([
        t.role === "owner" ? listInvoices(deps.db, t.tenant_id, 50) : Promise.resolve([]),
        Promise.all([deps.chain.mandates(t.vault_id), deps.chain.spends(t.vault_id)]).catch(
          (error: unknown) => {
            log.warn("ext.inbox_chain_unavailable", { vault: t.vault_id, error });
            return null;
          },
        ),
      ]);
      const [mandates, spends] = chain ?? [[], []];
      const waiting = rows.filter((r) => r.status === "awaiting_owner");
      // Only a hold an approver can still approve: the vault refuses approve once the hold has run out (HoldExpired).
      const held = spends.filter(
        (s) => s.status === "held" && heldActions(s.held_until_ns, false, nowMs).canApprove,
      );
      counts.awaiting += waiting.length;
      counts.held += held.length;
      return {
        vault: t.vault_id,
        name: safeText(t.display_name, 64),
        role: t.role === "owner" ? "owner" : "approver",
        chain: chain === null ? "unavailable" : "ok",
        awaiting: waiting.slice(0, MAX_ROWS).map((r) => {
          const m = mandates.find((x) => x.id === r.mandate_id);
          return {
            id: r.id,
            ref: safeText(r.ref, 64),
            amount: usdcText(r.suggested_amount ?? ""),
            payee: m === undefined ? null : payeeOrNull(m.payee),
            created_at: r.created_at,
            url: `${base}/payables/${encodeURIComponent(r.id)}`,
            source: r.source === "extension" ? "extension" : "console",
          };
        }),
        held: held
          .slice(-MAX_ROWS)
          .reverse()
          .map((s) => ({
            spend_id: s.id,
            amount: usdcText(s.amount),
            payee: payeeOrNull(s.destination) ?? "an unreadable payee",
            held_until: isoOrNull(s.held_until_ns),
            url: base,
          })),
        mandates: mandates.flatMap((m) => {
          const remaining = usableRemaining(m, nowMs);
          const payee = payeeOrNull(m.payee);
          const expires = isoOrNull(m.expires_at_ns);
          if (remaining === null || payee === null || expires === null) return [];
          return [
            {
              id: m.id,
              label: typeof m.label === "string" ? safeText(m.label, 64) : "unreadable",
              payee,
              per_payment: usdcText(m.max_per_payment),
              remaining: usdcText(remaining),
              expires_at: expires,
            },
          ];
        }),
      };
    }),
  );
  return { network: a.network, account: a.account, counts, vaults };
}
