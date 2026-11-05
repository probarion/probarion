import type { LedgerEntry } from "@probarion/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ConfirmInvoicePanel } from "@/components/console/ConfirmInvoicePanel";
import { CycleColumns } from "@/components/console/CycleColumns";
import { VaultNav } from "@/components/console/VaultNav";
import { RouteLink } from "@/components/RouteLink";
import { Badge, Card, Notice, type Tone } from "@/components/ui";
import { requireMember } from "@/lib/auth/guard";
import { masterKey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { SupabaseLedgerStore } from "@/lib/ledger/store";
import { log } from "@/lib/log";
import { getReader } from "@/lib/near/server";
import { getInvoice, listInvoices } from "@/lib/payables/store";
import {
  amountIssueText,
  buildCycleView,
  type PayeeRow,
  rowResult,
  usdcFixed,
} from "@/lib/payables/view";
import { loadWaitingView, type WaitingView } from "@/lib/payables/waiting";
import { safeText } from "@/lib/proof/sanitize";
import { chainCommand } from "@/lib/proof/view";
import { confirmInvoiceAction, prepareConfirmAction, rejectInvoiceAction } from "../actions";

export const metadata: Metadata = { title: "Invoice" };
/** Confirm waits for the payment cycle (check_spend, spend, anchor) in its server action. */
export const maxDuration = 60;

const muted = "text-ink/60";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const when = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? safeText(iso, 40)
    : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

const MATCH: Record<NonNullable<PayeeRow["match"]>, { tone: Tone; label: string }> = {
  equal: { tone: "bad", label: "same amount" },
  near: { tone: "warn", label: "within 5%" },
};

function PayeeRows({ base, w }: { base: string; w: WaitingView }) {
  if (w.payee === null) {
    return (
      <Notice tone="warn">
        The vault&apos;s mandates could not be read, so this payee&apos;s other invoices cannot be
        listed. Do not confirm before you have checked them: reload to try again.
      </Notice>
    );
  }
  if (w.payee.rows.length === 0) {
    return (
      <p className={`text-sm ${muted}`}>No other invoice of this payee in the last 90 days.</p>
    );
  }
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-ink/10">
          <th>Uploaded</th>
          <th>Ref</th>
          <th>Amount</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {w.payee.rows.map((r) => (
          <tr key={r.id} className="border-b border-ink/10 align-top last:border-0">
            <td className="whitespace-nowrap">
              {when(r.createdAt)}
              <span className={`block text-xs ${muted}`}>by {r.createdBy}</span>
            </td>
            <td className="mono break-all">
              <Link className="underline" href={`${base}/${encodeURIComponent(r.id)}`}>
                {r.ref}
              </Link>
            </td>
            <td>
              {r.amount === null ? "unknown" : `${usdcFixed(r.amount)} USDC`}{" "}
              {r.match ? <Badge tone={MATCH[r.match].tone}>{MATCH[r.match].label}</Badge> : null}
            </td>
            <td>{r.label}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Waiting({
  w,
  owner,
  base,
  panel,
}: {
  w: WaitingView;
  owner: boolean;
  base: string;
  panel: ReactNode;
}) {
  const m = w.mandate;
  return (
    <Card title={owner ? "Waiting for you" : "Waiting for the owner"}>
      <p className="mb-3 text-sm">
        No attested model confirmed the amount the code read, so nothing was sent. The code read{" "}
        <strong>{usdcFixed(w.amount)} USDC</strong> ({w.amount} base units). The invoice was
        uploaded by <span className="mono">{w.uploadedBy}</span> at {when(w.uploadedAt)}.
      </p>
      <h3 className="mt-4 mb-1 text-sm font-semibold">Why it waits</h3>
      <ul className="text-xs">
        {w.reasons.before.map((r) => (
          <li key={r.id} className="mb-1 wrap-anywhere">
            <Badge tone={r.outcome === "refuse" ? "bad" : "warn"}>{r.outcome}</Badge>{" "}
            <code>{r.id}</code> {r.detail}
          </li>
        ))}
        {w.reasons.owner ? (
          <li className="mb-1 wrap-anywhere">
            <Badge tone="warn">{w.reasons.owner.outcome}</Badge> <code>{w.reasons.owner.id}</code>{" "}
            {w.reasons.owner.detail}
          </li>
        ) : null}
      </ul>
      {w.lastConfirmation ? (
        <Notice tone="warn">
          You last confirmed it as {w.lastConfirmation.by} at {when(w.lastConfirmation.at)}; the
          cycle was held again by the rule above and nothing was sent.
        </Notice>
      ) : null}

      <h3 className="mt-4 mb-1 text-sm font-semibold">The mandate, as the chain shows it</h3>
      {m ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          <dt>Mandate</dt>
          <dd>
            #{m.id} {m.label} · {m.status}
          </dd>
          <dt>Pays</dt>
          <dd className="mono break-all">{m.payee}</dd>
          <dt>Per payment</dt>
          <dd>{m.perPayment} USDC</dd>
          <dt>Total cap</dt>
          <dd>{m.total} USDC</dd>
          <dt>Spent / reserved</dt>
          <dd>
            {m.spent} / {m.reserved} USDC ({m.remaining} USDC left)
          </dd>
          <dt>Uses</dt>
          <dd>{m.uses}</dd>
          <dt>Held for approval above</dt>
          <dd>{m.approvalAbove} USDC</dd>
          <dt>Expires</dt>
          <dd>{m.expires}</dd>
        </dl>
      ) : (
        <Notice tone="warn">{w.mandateWhy}</Notice>
      )}

      <h3 className="mt-4 mb-1 text-sm font-semibold">The invoice</h3>
      {w.invoice.kind === "text" ? (
        <>
          {w.invoice.amountLine ? (
            <p className="mb-2 text-sm">
              The amount was read from line {w.invoice.amountLine.number}:{" "}
              <code className="wrap-anywhere">{w.invoice.amountLine.text}</code>
            </p>
          ) : (
            <p className={`mb-2 text-sm ${muted}`}>No line writes this amount as a figure.</p>
          )}
          <pre className="max-h-96 overflow-auto rounded-2xl border border-ink/10 bg-paper p-3 text-xs whitespace-pre-wrap wrap-anywhere">
            {w.invoice.lines.join("\n")}
          </pre>
          {w.invoice.more > 0 ? (
            <p className={`text-xs ${muted}`}>… and {w.invoice.more} more lines.</p>
          ) : null}
        </>
      ) : w.invoice.kind === "hash" ? (
        <p className="text-sm wrap-anywhere">
          Zero-retention: only the hashes are kept. Invoice text sha256{" "}
          <span className="mono">{w.invoice.invoiceHash}</span>
          {w.invoice.documentSha256 ? (
            <>
              , file sha256 <span className="mono">{w.invoice.documentSha256}</span>
            </>
          ) : null}
          . Compare them with the invoice you hold before you confirm.
        </p>
      ) : (
        <Notice tone="warn">
          The stored invoice could not be opened. Check the invoice you hold.
        </Notice>
      )}

      <h3 className="mt-4 mb-1 text-sm font-semibold">
        This payee&apos;s other invoices (last 90 days, every amount)
      </h3>
      <PayeeRows base={base} w={w} />

      <div className="mt-4 border-t border-ink/10 pt-3">
        {panel ?? <p className={`text-sm ${muted}`}>{w.whyNot}</p>}
      </div>
    </Card>
  );
}

export default async function InvoiceCyclePage({
  params,
}: {
  params: Promise<{ vault: string; id: string }>;
}) {
  const { vault: requested, id } = await params;
  // 404 for anyone who is not a member: a vault id is never confirmed to a stranger.
  const { session, member } = await requireMember(requested);
  if (!UUID.test(id)) notFound();
  const db = serviceDb();
  const inv = await getInvoice(db, member.tenant_id, id);
  if (!inv) notFound();
  const vault = member.vault_id;
  const owner = member.role === "owner";
  const network = getEnv().NEAR_NETWORK;
  const base = `/console/${encodeURIComponent(vault)}/payables`;
  let entries: LedgerEntry[] | null = null;
  try {
    entries = await new SupabaseLedgerStore(db, member.tenant_id).all();
  } catch (error) {
    log.warn("payables.ledger_unreadable", {
      tenant: member.tenant_id,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  const waiting =
    inv.status === "awaiting_owner" && entries !== null
      ? await loadWaitingView(
          { db, master: masterKey(), reader: getReader() },
          {
            member,
            account: session.accountId,
            row: inv,
            entries,
            rows: await listInvoices(db, member.tenant_id, 200),
            now: new Date(),
          },
        )
      : null;
  const result = rowResult(inv, owner);
  const m = waiting?.mandate ?? null;

  return (
    <div>
      <h1 className="mono mb-1 text-2xl font-semibold break-all">{vault}</h1>
      <p className={`mb-4 text-sm ${muted}`}>
        <Link className="underline" href={base}>
          Payables
        </Link>{" "}
        · invoice
      </p>
      <VaultNav vault={vault} />
      <h2 className="mb-1 text-lg">
        Invoice <span className="mono">{safeText(inv.ref, 64)}</span>{" "}
        <Badge tone={result.tone}>{result.label}</Badge>
      </h2>
      <p className={`mb-4 text-xs ${muted}`}>
        uploaded by <span className="mono">{safeText(inv.created_by, 64)}</span> at{" "}
        {when(inv.created_at)} · request{" "}
        <span className="mono">{safeText(inv.request_id, 64)}</span>
        {inv.retained
          ? ` · ${inv.filename ? safeText(inv.filename, 120) : "pasted text"}`
          : " · not stored (zero-retention)"}
      </p>
      {inv.amount_issue ? <Notice tone="bad">{amountIssueText(inv.amount_issue)}</Notice> : null}
      {inv.status === "processing" ? (
        <Notice tone="warn">
          Outcome unknown: do not resend. The cycle may still be running, or it was cut off; the
          watcher confirms it from the chain by its ref.
        </Notice>
      ) : null}
      {inv.status === "unconfirmed" ? (
        <Notice tone="warn">
          Payment sent, confirmation pending: do not resend. The spend is confirmed from the chain.
        </Notice>
      ) : null}
      {inv.status === "rejected" ? (
        <Notice>
          Rejected by {safeText(inv.rejected_by ?? "the owner", 64)}
          {inv.rejected_at ? ` at ${when(inv.rejected_at)}` : ""}: nothing was paid.
        </Notice>
      ) : null}
      {inv.confirmed_by && inv.status !== "awaiting_owner" ? (
        <Notice tone="good">
          Confirmed by the owner {safeText(inv.confirmed_by, 64)}
          {inv.confirmed_at ? ` at ${when(inv.confirmed_at)}` : ""} with a NEP-413 signature; the
          signed ledger&apos;s rule custom.owner_confirmed holds the full record.
        </Notice>
      ) : null}

      {waiting ? (
        <Waiting
          w={waiting}
          owner={owner}
          base={base}
          panel={
            waiting.canConfirm && waiting.snapshot && m ? (
              <ConfirmInvoicePanel
                owner={session.accountId}
                amountText={`${usdcFixed(waiting.amount)} USDC (${waiting.amount} base units)`}
                payee={m.payee}
                mandateId={m.id}
                seen={waiting.snapshot}
                prepare={prepareConfirmAction.bind(null, vault, inv.id)}
                confirm={confirmInvoiceAction.bind(null, vault, inv.id)}
                reject={rejectInvoiceAction.bind(null, vault, inv.id)}
              />
            ) : null
          }
        />
      ) : inv.status === "awaiting_owner" ? (
        <Notice tone="warn">
          This invoice waits for the owner, but the ledger could not be read, so nothing is offered.
          Reload to try again.
        </Notice>
      ) : null}

      {inv.outcome && entries !== null ? (
        <CycleColumns
          view={buildCycleView(entries, inv.outcome, network, inv.anchor_tx_hash)}
          network={network}
        />
      ) : inv.outcome ? (
        <Notice tone="warn">The ledger could not be read, so the cycle cannot be shown.</Notice>
      ) : (
        <Notice tone={inv.status === "error" ? "bad" : "info"}>
          {inv.error ? safeText(inv.error, 500) : `Status: ${result.label}`}
        </Notice>
      )}

      <p className="mt-4 text-sm">
        Check it yourself: the{" "}
        <RouteLink route="/proof/[vault]" href={`/proof/${encodeURIComponent(vault)}`}>
          proof page
        </RouteLink>{" "}
        has the ledger file and the one-time setup, then run{" "}
        <code className="wrap-anywhere">{chainCommand(network, vault)}</code>.
      </p>
    </div>
  );
}
