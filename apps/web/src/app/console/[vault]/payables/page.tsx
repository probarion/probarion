import type { Metadata } from "next";
import Link from "next/link";
import { InvoiceUploadForm } from "@/components/console/InvoiceUploadForm";
import { VaultNav } from "@/components/console/VaultNav";
import { VaultOnOtherNetwork } from "@/components/console/VaultOnOtherNetwork";
import { Badge, Card, linePillClass, Notice } from "@/components/ui";
import { requireMember } from "@/lib/auth/guard";
import { serviceDb } from "@/lib/db/clients";
import { utcMinute } from "@/lib/payables/forms";
import { listInvoices } from "@/lib/payables/store";
import { amountIssueText, rowResult } from "@/lib/payables/view";
import { safeText } from "@/lib/proof/sanitize";
import { setZeroRetentionAction } from "./actions";

export const metadata: Metadata = { title: "Payables" };

const muted = "text-ink/60";

export default async function PayablesPage({ params }: { params: Promise<{ vault: string }> }) {
  const { vault: requested } = await params;
  // 404 for anyone who is not a member: a vault id is never confirmed to a stranger.
  const { member, elsewhere } = await requireMember(requested);
  if (elsewhere) return <VaultOnOtherNetwork {...elsewhere} />;
  const vault = member.vault_id;
  const owner = member.role === "owner";
  const canUpload = member.role === "owner" || member.role === "approver";
  const invoices = await listInvoices(serviceDb(), member.tenant_id, 50);
  const waiting = invoices.filter((i) => i.status === "awaiting_owner").length;
  const base = `/console/${encodeURIComponent(vault)}/payables`;

  return (
    <div>
      <h1 className="mono mb-1 text-2xl font-semibold break-all">{vault}</h1>
      <p className={`mb-4 text-sm ${muted}`}>Payables · you are {member.role}</p>
      <VaultNav vault={vault} />
      <Notice>
        Payables is the reference accounts-payable agent. Code reads the amount; an attested private
        model on NEAR AI Cloud must confirm it before the agent pays on its own; otherwise the
        invoice waits for you. Named code rules decide, the vault contract enforces, and the payee
        always comes from the mandate, never from the invoice.
      </Notice>
      {waiting > 0 ? (
        <Notice tone="warn">
          {waiting} invoice{waiting === 1 ? "" : "s"}{" "}
          {owner
            ? "wait for you to confirm or reject the amount."
            : "wait for the owner to confirm or reject the amount."}
        </Notice>
      ) : null}

      {canUpload ? (
        <Card title="New invoice">
          <InvoiceUploadForm vault={vault} />
        </Card>
      ) : (
        <p className={`mb-6 text-sm ${muted}`}>
          Only the owner or an approver can upload invoices.
        </p>
      )}

      <Card title="Retention">
        <p className="text-sm">
          {member.zero_retention
            ? "Zero-retention is on: the invoice file and text are not stored, only their hashes and the outcome; the model's answer, which may quote details, is part of the signed ledger."
            : "Invoices are stored encrypted with a per-vault key, with the facts the code read."}
        </p>
        {member.proof_public ? (
          <Notice tone="warn">
            Your proof page is public: the ledger, including the model&apos;s answers, can be read
            by anyone at /proof/{vault}.
          </Notice>
        ) : null}
        {owner ? (
          <form action={setZeroRetentionAction.bind(null, vault)} className="mt-3 text-sm">
            <label className="mb-2 block">
              <input type="checkbox" name="zero_retention" defaultChecked={member.zero_retention} />{" "}
              Zero-retention: the invoice file and text are not stored; the model&apos;s answer,
              which may quote details, is part of the signed ledger
            </label>
            <button className={linePillClass} type="submit">
              Save
            </button>
          </form>
        ) : (
          <p className={`mt-2 text-xs ${muted}`}>Only the owner can change this.</p>
        )}
        <p className={`mt-2 text-xs ${muted}`}>
          With a model key set, the invoice text is sent to the attested private model on NEAR AI
          Cloud for the decision, in either mode.
        </p>
      </Card>

      <Card title="Recent invoices">
        {invoices.length === 0 ? (
          <p className={`text-sm ${muted}`}>No invoices yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-ink/10">
                  <th>When</th>
                  <th>Ref</th>
                  <th>File</th>
                  <th>Result</th>
                  <th>Stored</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => {
                  const r = rowResult(i, owner);
                  return (
                    <tr key={i.id} className="border-b border-ink/10 align-top last:border-0">
                      <td className="whitespace-nowrap">{utcMinute(i.created_at)}</td>
                      <td className="mono break-all">
                        <Link className="underline" href={`${base}/${encodeURIComponent(i.id)}`}>
                          {safeText(i.ref, 64)}
                        </Link>
                      </td>
                      <td className="break-all">
                        {i.retained
                          ? i.filename
                            ? safeText(i.filename, 120)
                            : "pasted text"
                          : "not stored"}
                      </td>
                      <td>
                        <Badge tone={r.tone}>{r.label}</Badge>
                        {i.amount_issue ? (
                          <p className={`mt-1 text-xs ${muted}`}>
                            {amountIssueText(i.amount_issue)}
                          </p>
                        ) : null}
                      </td>
                      <td>{i.retained ? "encrypted" : "hash only"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
