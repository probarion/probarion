import type { LedgerEntry } from "@probarion/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ConfirmInvoicePanel } from "@/components/console/ConfirmInvoicePanel";
import { CycleColumns } from "@/components/console/CycleColumns";
import { VaultNav } from "@/components/console/VaultNav";
import { VaultOnOtherNetwork } from "@/components/console/VaultOnOtherNetwork";
import { RouteLink } from "@/components/RouteLink";
import { Badge, Card, Notice, type Tone } from "@/components/ui";
import { requireMember } from "@/lib/auth/guard";
import { masterKey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import { SupabaseLedgerStore } from "@/lib/ledger/store";
import { log } from "@/lib/log";
import { getReader } from "@/lib/near/server";
import { UUID, utcMinute } from "@/lib/payables/forms";
import { ledgerHoldsConfirmation } from "@/lib/payables/owner-confirmed";
import { getInvoice } from "@/lib/payables/store";
import {
  amountIssueText,
  buildCycleView,
  type PayeeRow,
  rowResult,
  shownOutcome,
  usdcFixed,
} from "@/lib/payables/view";
import { loadWaitingView, type WaitingView } from "@/lib/payables/waiting";
import { CLI_ON_NPM } from "@/lib/proof/cli";
import { safeText } from "@/lib/proof/sanitize";
import { chainCommand } from "@/lib/proof/view";
import { confirmInvoiceAction, prepareConfirmAction, rejectInvoiceAction } from "../actions";

export const metadata: Metadata = { title: "Invoice" };
/**
 * Confirm runs the whole payment cycle (check_spend, spend, anchor) in its server action, under the tenant's process
 * lease (PROCESS_LEASE_SECONDS, 90 s), which outlasts this with a 30 s margin; payables-confirm.test.ts checks it.
 */
export const maxDuration = 60;

const muted = "text-ink/60";

const MATCH: Record<NonNullable<PayeeRow["match"]>, { tone: Tone; label: string }> = {
  equal: { tone: "bad", label: "same amount" },
  near: { tone: "warn", label: "within 5%" },
};

function PayeeRows({ base, w }: { base: string; w: WaitingView }) {
  if (w.payee === null || w.payeeProblem !== null) {
    return <Notice tone="warn">{w.payeeProblem}</Notice>;
  }
  if (w.payee.rows.length === 0) {
    return (
      <p className={`text-sm ${muted}`}>No other invoice of this payee in the last 90 days.</p>
    );
  }
  return (
    <div className="overflow-x-auto">
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
              <td>
                <span className="whitespace-nowrap">{utcMinute(r.createdAt)}</span>
                <span className={`block text-xs break-all ${muted}`}>by {r.createdBy}</span>
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
    </div>
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
        uploaded by <span className="mono break-all">{w.uploadedBy}</span> at{" "}
        {utcMinute(w.uploadedAt)}.
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
          It was last confirmed as {w.lastConfirmation.by} at {utcMinute(w.lastConfirmation.at)}.
          The cycle was held again by the rule above, and nothing was sent.
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
            <p className={`mb-2 text-sm ${muted}`}>
              The reader does not read this amount from the stored text now, so the line the amount
              was read from cannot be shown.
            </p>
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
          . The text is not stored, so the line the amount was read from cannot be shown: compare
          the hashes with the invoice you hold before you confirm.
        </p>
      ) : w.invoice.kind === "mismatch" ? (
        <Notice tone="bad">
          The stored invoice does not match the hash this invoice was recorded with (sha256{" "}
          <span className="mono break-all">{w.invoice.invoiceHash}</span>), so its text and the line
          the amount was read from are not shown.
        </Notice>
      ) : (
        <Notice tone="warn">
          The stored invoice could not be opened, so it cannot be checked against its hash and the
          line the amount was read from cannot be shown.
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
  const { session, member, elsewhere } = await requireMember(requested);
  if (elsewhere) return <VaultOnOtherNetwork {...elsewhere} />;
  if (!UUID.test(id)) notFound();
  const db = serviceDb();
  const inv = await getInvoice(db, member.tenant_id, id);
  if (!inv) notFound();
  const vault = member.vault_id;
  const owner = member.role === "owner";
  const network = member.network;
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
          { db, master: masterKey(), reader: getReader(network) },
          {
            member,
            account: session.accountId,
            row: inv,
            entries,
            now: new Date(),
          },
        )
      : null;
  const result = rowResult(inv, owner);
  const outcome = shownOutcome(inv);
  const ref = safeText(inv.ref, 64);
  const confirmationInLedger =
    entries !== null && ledgerHoldsConfirmation(entries, inv.invoice_hash, inv.confirm_signature);
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
        Invoice <span className="mono break-all">{ref}</span>{" "}
        <Badge tone={result.tone}>{result.label}</Badge>
      </h2>
      <p className={`mb-4 text-xs ${muted}`}>
        uploaded by <span className="mono break-all">{safeText(inv.created_by, 64)}</span> at{" "}
        {utcMinute(inv.created_at)} · request{" "}
        <span className="mono break-all">{safeText(inv.request_id, 64)}</span>
        {inv.retained
          ? ` · ${inv.filename ? safeText(inv.filename, 120) : "pasted text"}`
          : " · not stored (zero-retention)"}
      </p>
      {inv.amount_issue ? <Notice tone="bad">{amountIssueText(inv.amount_issue)}</Notice> : null}
      {inv.status === "processing" ? (
        <Notice tone="warn">
          Outcome unknown: do not resend. The cycle may still be running; if it was cut off, this
          row stays in this state. You can read the vault&apos;s spends on chain by this ref:{" "}
          <span className="mono break-all">{ref}</span>.
        </Notice>
      ) : null}
      {inv.status === "unconfirmed" ? (
        <Notice tone="warn">
          Payment sent, confirmation pending: do not resend. This row stays in this state. You can
          read the vault&apos;s spends on chain by this ref:{" "}
          <span className="mono break-all">{ref}</span>.
        </Notice>
      ) : null}
      {inv.status === "rejected" ? (
        <Notice>
          Rejected by {safeText(inv.rejected_by ?? "the owner", 64)}
          {inv.rejected_at ? ` at ${utcMinute(inv.rejected_at)}` : ""}: nothing was paid.
        </Notice>
      ) : null}
      {inv.confirmed_by && inv.status === "rejected" ? (
        <Notice tone="neutral">
          An earlier confirmation by {safeText(inv.confirmed_by, 64)}
          {inv.confirmed_at ? ` at ${utcMinute(inv.confirmed_at)}` : ""} sent nothing.
        </Notice>
      ) : inv.confirmed_by && (inv.status === "decided" || inv.status === "unconfirmed") ? (
        <Notice tone={result.tone}>
          Confirmed by the owner {safeText(inv.confirmed_by, 64)}
          {inv.confirmed_at ? ` at ${utcMinute(inv.confirmed_at)}` : ""} with a NEP-413 signature;
          the signed ledger&apos;s rule custom.owner_confirmed holds the signature, the key and the
          message. The block of the key check in that record is the server&apos;s, not signed by the
          owner.
        </Notice>
      ) : inv.confirmed_by && inv.status !== "awaiting_owner" ? (
        <Notice tone={result.tone}>
          {`The owner confirmed this${inv.confirmed_at ? ` at ${utcMinute(inv.confirmed_at)}` : ""}; the cycle has not been recorded as finished, so the ledger may hold no record of it.`}
        </Notice>
      ) : null}

      {waiting ? (
        <Waiting
          w={waiting}
          owner={owner}
          base={base}
          panel={
            waiting.canReject && waiting.snapshot ? (
              <ConfirmInvoicePanel
                owner={session.accountId}
                canConfirm={waiting.canConfirm}
                whyNot={waiting.whyNot === waiting.mandateWhy ? null : waiting.whyNot}
                amountText={`${usdcFixed(waiting.amount)} USDC (${waiting.amount} base units)`}
                payee={m?.payee ?? null}
                mandateId={m?.id ?? null}
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

      {outcome && entries !== null ? (
        <CycleColumns
          view={buildCycleView(entries, outcome, network, inv.anchor_tx_hash)}
          network={network}
        />
      ) : outcome ? (
        <Notice tone="warn">The ledger could not be read, so the cycle cannot be shown.</Notice>
      ) : inv.status === "processing" ? (
        <Notice tone="warn">Not recorded yet: do not resend.</Notice>
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
        {CLI_ON_NPM
          ? "has the ledger file to download first, then run"
          : "has the ledger file and the one-time setup, then run"}{" "}
        <code className="wrap-anywhere">{chainCommand(network, vault)}</code>.
        {confirmationInLedger
          ? " That command does not check an owner's confirmation yet: its signature can be re-checked from the ledger entry's custom.owner_confirmed record, and whether the key was the owner's at that block takes an archival node."
          : null}
      </p>
    </div>
  );
}
