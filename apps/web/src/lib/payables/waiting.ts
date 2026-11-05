import "server-only";
import type { LedgerEntry, MandateView } from "@probarion/core";
import { remainingUnits, safeChainText, usdcText } from "@/lib/console/mandates-view";
import { openInvoice } from "@/lib/crypto/secrets";
import type { Db } from "@/lib/db/port";
import type { MemberTenant } from "@/lib/db/tenants";
import { log } from "@/lib/log";
import { listAll, type VaultReader } from "@/lib/near/reader";
import { nsToDate } from "@/lib/near/units";
import { safeText } from "@/lib/proof/sanitize";
import { payeeText } from "./confirm-message";
import { extractInvoice } from "./extract";
import { type InvoiceRow, invoiceContent, type RowSnapshot } from "./store";
import { amountLine, type PayeeRow, recentPayeeRows, type ShownRule, waitReasons } from "./view";

// What the page shows next to an invoice that waits for the owner, before any button (rulings W-T14-R0 and R1): the
// amount, why it waits, the mandate as the chain shows it, the invoice (its text when retained, else its hashes), who
// uploaded it, and every recent invoice of the same payee. Read on the server; every string is made safe to show.

export interface MandateSummary {
  id: number;
  label: string;
  payee: string;
  perPayment: string;
  total: string;
  spent: string;
  reserved: string;
  remaining: string;
  approvalAbove: string;
  uses: string;
  status: string;
  expires: string;
}

export type InvoiceShown =
  | {
      kind: "text";
      lines: string[];
      /** Lines not shown (the page shows the first MAX_LINES). */
      more: number;
      amountLine: { number: number; text: string } | null;
    }
  | { kind: "hash"; invoiceHash: string; documentSha256: string | null }
  | { kind: "unreadable" };

export interface WaitingView {
  amount: string;
  reasons: { owner: ShownRule | null; before: ShownRule[] };
  uploadedBy: string;
  uploadedAt: string;
  mandate: MandateSummary | null;
  /** Why the mandate is not shown (chain unreadable, not on the vault, no mandate on the row), or null. */
  mandateWhy: string | null;
  invoice: InvoiceShown;
  /** Null when the mandates could not be read (the list cannot be built). */
  payee: { payee: string | null; rows: PayeeRow[] } | null;
  /** The owner's button is shown only when this is true. */
  canConfirm: boolean;
  whyNot: string | null;
  /** What Confirm and Reject are bound to: the row as the owner sees it. */
  snapshot: RowSnapshot | null;
  /** The owner's last confirmation of this row (a confirmed cycle that was held again), or null. */
  lastConfirmation: { by: string; at: string } | null;
}

const MAX_LINES = 200;

function summary(m: MandateView): MandateSummary {
  let payee: string;
  try {
    payee = payeeText(m.payee);
  } catch {
    payee = "unreadable payee";
  }
  const expires =
    typeof m.expires_at_ns === "string" && /^[0-9]+$/.test(m.expires_at_ns)
      ? `${nsToDate(m.expires_at_ns).toISOString().slice(0, 16).replace("T", " ")} UTC`
      : "unreadable";
  const remaining = remainingUnits(m);
  return {
    id: m.id,
    label: safeChainText(m.label),
    payee,
    perPayment: usdcText(m.max_per_payment),
    total: usdcText(m.max_total),
    spent: usdcText(m.spent),
    reserved: usdcText(m.reserved),
    remaining: remaining === null ? "unreadable" : usdcText(remaining),
    approvalAbove: usdcText(m.approval_above),
    uses: `${Number(m.uses)} of ${Number(m.max_uses)}`,
    status: safeChainText(m.status),
    expires,
  };
}

async function invoiceShown(
  db: Db,
  master: Uint8Array,
  tenantId: string,
  row: InvoiceRow,
): Promise<InvoiceShown> {
  if (!row.retained) {
    return { kind: "hash", invoiceHash: row.invoice_hash, documentSha256: row.document_sha256 };
  }
  try {
    const content = await invoiceContent(db, tenantId, row.id);
    if (content === null) return { kind: "unreadable" };
    const bytes = await openInvoice(master, tenantId, content.sealed);
    const { text } = await extractInvoice({ bytes, mediaType: content.mediaType });
    const all = text.split(/\r\n|\r|\n/);
    return {
      kind: "text",
      lines: all.slice(0, MAX_LINES).map((l) => safeText(l, 300)),
      more: Math.max(0, all.length - MAX_LINES),
      amountLine: row.suggested_amount ? amountLine(text, row.suggested_amount) : null,
    };
  } catch (error) {
    log.warn("payables.invoice_unreadable", {
      tenant: tenantId,
      invoice: row.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { kind: "unreadable" };
  }
}

export async function loadWaitingView(
  deps: { db: Db; master: Uint8Array; reader: Pick<VaultReader, "getConfig" | "listMandates"> },
  a: {
    member: MemberTenant;
    account: string;
    row: InvoiceRow;
    entries: readonly LedgerEntry[];
    rows: readonly InvoiceRow[];
    now: Date;
  },
): Promise<WaitingView> {
  const { member, row } = a;
  const owner = member.role === "owner";
  let chain: { owner: string; mandates: MandateView[] } | null = null;
  try {
    const [config, mandates] = await Promise.all([
      deps.reader.getConfig(member.vault_id),
      listAll((from, limit) => deps.reader.listMandates(member.vault_id, from, limit), 100),
    ]);
    chain = { owner: config.owner, mandates };
  } catch (error) {
    log.warn("payables.waiting_chain_unavailable", {
      tenant: member.tenant_id,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  const mandate =
    chain === null || row.mandate_id === null
      ? null
      : (chain.mandates.find((m) => m.id === row.mandate_id) ?? null);
  const mandateWhy =
    row.mandate_id === null
      ? "This invoice was recorded without its mandate: reject it and upload it again."
      : chain === null
        ? "The vault's mandates could not be read from NEAR. Reload to try again."
        : mandate === null
          ? `Mandate #${row.mandate_id} is not on the vault.`
          : null;
  let payeeOk = mandate !== null;
  if (mandate !== null) {
    try {
      payeeText(mandate.payee);
    } catch {
      payeeOk = false;
    }
  }
  const snapshot =
    row.status === "awaiting_owner" && row.suggested_amount !== null && row.mandate_id !== null
      ? {
          suggestedAmount: row.suggested_amount,
          invoiceHash: row.invoice_hash,
          mandateId: row.mandate_id,
        }
      : null;
  const whyNot = !owner
    ? "Only the owner can confirm or reject this invoice."
    : chain === null
      ? "The vault's config could not be read from NEAR, so Confirm is not offered. Reload to try again."
      : chain.owner !== a.account
        ? "You are not the vault's on-chain owner, so Confirm is not offered."
        : mandateWhy !== null
          ? mandateWhy
          : !payeeOk
            ? "The mandate's payee is not in a form the confirmation message accepts."
            : snapshot === null
              ? "This invoice does not wait for you."
              : null;
  return {
    amount: row.suggested_amount ?? "0",
    reasons: row.outcome ? waitReasons(a.entries, row.outcome) : { owner: null, before: [] },
    uploadedBy: safeText(row.created_by, 64),
    uploadedAt: row.created_at,
    mandate: mandate === null ? null : summary(mandate),
    mandateWhy,
    invoice: await invoiceShown(deps.db, deps.master, member.tenant_id, row),
    payee:
      chain === null
        ? null
        : (({ payee, rows }) => ({ payee, rows }))(
            recentPayeeRows(row, a.rows, a.entries, chain.mandates, a.now, owner),
          ),
    canConfirm: whyNot === null,
    whyNot,
    snapshot,
    lastConfirmation:
      row.confirmed_by && row.confirmed_at
        ? { by: safeText(row.confirmed_by, 64), at: row.confirmed_at }
        : null,
  };
}
