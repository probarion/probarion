import "server-only";
import type { LedgerEntry, MandateView } from "@probarion/core";
import { hashInvoice } from "@probarion/sdk";
import { remainingUnits, safeChainText, usdcText } from "@/lib/console/mandates-view";
import { openInvoice } from "@/lib/crypto/secrets";
import type { Db } from "@/lib/db/port";
import type { MemberTenant } from "@/lib/db/tenants";
import { log } from "@/lib/log";
import { nsToDate } from "@/lib/near/units";
import { safeText } from "@/lib/proof/sanitize";
import { readVaultFacts, type VaultFactsReader } from "./chain";
import { REFUSAL_TEXT } from "./confirm";
import { payeeText } from "./confirm-message";
import { extractInvoice } from "./extract";
import { payeeId } from "./payee";
import { invoiceLines, sourceLine, verbatimLine } from "./source-line";
import { type InvoiceRow, invoiceContent, listPayeeRecent, type RowSnapshot } from "./store";
import { type PayeeRow, payeeOf, recentPayeeRows, type ShownRule, waitReasons } from "./view";

// What the page shows next to an invoice that waits for the owner, before any button (rulings W-T14-R0, R1 and R2): the
// amount, why it waits, the mandate as the chain shows it, the invoice (its text and the line the reader read the total
// from when retained, else its hashes), who uploaded it, and every recent invoice of the same payee. Read on the
// server; every string is made safe to show.

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
      /** The line the reader reads the amount from, or null when it does not read that amount from this text now. */
      amountLine: { number: number; text: string } | null;
    }
  | { kind: "hash"; invoiceHash: string; documentSha256: string | null }
  /** The stored file does not hash to the invoice's hash: its text is not shown, and Confirm is not offered. */
  | { kind: "mismatch"; invoiceHash: string }
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
  /** Null when the list could not be read. `payee` null: the invoice's payee could not be determined. */
  payee: { payee: string | null; rows: PayeeRow[] } | null;
  /** Why the list cannot be shown, naming the real cause; Confirm is not offered while this is set. */
  payeeProblem: string | null;
  /** Confirm is offered only when this is true; `whyNot` says why when it is not. */
  canConfirm: boolean;
  whyNot: string | null;
  /** Reject is offered to the owner whenever the row waits: it needs no chain and no mandate. */
  canReject: boolean;
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
    // The owner signs this hash: the text shown beside the signature must be the text it was made from.
    if (hashInvoice(text) !== row.invoice_hash) {
      log.error("payables.invoice_hash_mismatch", { tenant: tenantId, invoice: row.id });
      return { kind: "mismatch", invoiceHash: row.invoice_hash };
    }
    const all = invoiceLines(text);
    const source = row.suggested_amount ? sourceLine(text, row.suggested_amount) : null;
    return {
      kind: "text",
      lines: all
        .slice(0, MAX_LINES)
        .map((l, i) => (i + 1 === source?.number ? source.text : verbatimLine(l))),
      more: Math.max(0, all.length - MAX_LINES),
      amountLine: source,
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

const NO_MANDATES =
  "The vault's mandates could not be read, so this payee's other invoices cannot be listed. Do not confirm before you have checked them: reload to try again.";
const NO_PAYEE =
  "This invoice's payee could not be determined, so its other invoices cannot be listed and Confirm is not offered.";
const NO_LIST =
  "This payee's other invoices could not be read from the database, so they cannot be listed and Confirm is not offered. Reload to try again.";

/** Every invoice of this row's payee from the last 90 days, read without a cap, or why it cannot be listed. */
async function payeeList(
  db: Db,
  a: { member: MemberTenant; row: InvoiceRow; entries: readonly LedgerEntry[]; now: Date },
  mandates: readonly MandateView[],
): Promise<Pick<WaitingView, "payee" | "payeeProblem">> {
  const mine = payeeOf(a.row, a.entries, mandates);
  if (mine === null) return { payee: { payee: null, rows: [] }, payeeProblem: NO_PAYEE };
  const ids = mandates.filter((m) => payeeId(m.payee) === mine).map((m) => m.id);
  try {
    const rows = await listPayeeRecent(db, a.member.tenant_id, ids);
    const owner = a.member.role === "owner";
    const r = recentPayeeRows(a.row, rows, a.entries, mandates, a.now, owner);
    return { payee: { payee: r.payee, rows: r.rows }, payeeProblem: null };
  } catch (error) {
    log.warn("payables.payee_list_unavailable", {
      tenant: a.member.tenant_id,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { payee: null, payeeProblem: NO_LIST };
  }
}

export async function loadWaitingView(
  deps: { db: Db; master: Uint8Array; reader: VaultFactsReader },
  a: {
    member: MemberTenant;
    account: string;
    row: InvoiceRow;
    entries: readonly LedgerEntry[];
    now: Date;
  },
): Promise<WaitingView> {
  const { member, row } = a;
  const owner = member.role === "owner";
  const chain = await readVaultFacts(deps.reader, member.vault_id);
  const mandate =
    chain === null || row.mandate_id === null
      ? null
      : (chain.mandates.find((m) => m.id === row.mandate_id) ?? null);
  const mandateWhy =
    row.mandate_id === null
      ? REFUSAL_TEXT.no_mandate
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
  const waits = row.status === "awaiting_owner" && row.suggested_amount !== null;
  const snapshot: RowSnapshot | null =
    waits && row.suggested_amount !== null
      ? {
          suggestedAmount: row.suggested_amount,
          invoiceHash: row.invoice_hash,
          mandateId: row.mandate_id,
        }
      : null;
  const invoice = await invoiceShown(deps.db, deps.master, member.tenant_id, row);
  const list: Pick<WaitingView, "payee" | "payeeProblem"> =
    chain === null
      ? { payee: null, payeeProblem: NO_MANDATES }
      : await payeeList(deps.db, a, chain.mandates);
  const whyNot = !owner
    ? "Only the owner can confirm or reject this invoice."
    : chain === null
      ? "The vault's config could not be read from NEAR, so Confirm is not offered. Reload to try again."
      : chain.owner !== a.account
        ? "You are not the vault's on-chain owner, so Confirm is not offered."
        : mandateWhy !== null
          ? mandateWhy
          : !payeeOk
            ? "The mandate's payee is not in a form the confirmation message accepts, so Confirm is not offered."
            : !waits
              ? "This invoice does not wait for you."
              : invoice.kind === "mismatch"
                ? "The stored invoice does not match the hash you would sign, so Confirm is not offered."
                : invoice.kind === "unreadable"
                  ? "The stored invoice could not be re-read and checked against its hash, so Confirm is not offered. Reload to try again."
                  : list.payeeProblem !== null
                    ? "Confirm is not offered until this payee's other invoices can be listed."
                    : null;
  return {
    amount: row.suggested_amount ?? "0",
    reasons: row.outcome ? waitReasons(a.entries, row.outcome) : { owner: null, before: [] },
    uploadedBy: safeText(row.created_by, 64),
    uploadedAt: row.created_at,
    mandate: mandate === null ? null : summary(mandate),
    mandateWhy,
    invoice,
    ...list,
    canConfirm: whyNot === null,
    whyNot,
    canReject: owner && waits,
    snapshot,
    lastConfirmation:
      row.confirmed_by && row.confirmed_at
        ? { by: safeText(row.confirmed_by, 64), at: row.confirmed_at }
        : null,
  };
}
