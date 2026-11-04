import type { InvoiceFacts } from "@probarion/core";
import type { SpendOutcome } from "@probarion/sdk";
import type { Sealed } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import type { InvoiceMediaType } from "./extract";
import type { AmountIssue } from "./facts";

// The invoices rows as the service-role functions of migration 0006 read and write them. `tenantId` must come
// from the session's membership (memberRole) or a server job's own tenant row, never from a request.

/** received -> processing -> decided | unconfirmed | error (0001's check, 0006's functions). */
export type InvoiceStatus = "received" | "processing" | "decided" | "unconfirmed" | "error";

/** The facts kept for a retained invoice: the five `InvoiceFacts` plus the invoice number, for display. */
export type StoredFacts = InvoiceFacts & { invoice_number: string | null };

/** One invoice as `invoice_list` / `invoice_get` return it: never the sealed content or its nonce. */
export interface InvoiceRow {
  id: string;
  /** sha256 of the extracted text the model was shown. */
  invoice_hash: string;
  ref: string;
  /** Null for pasted text, and always null in zero-retention mode. */
  filename: string | null;
  media_type: InvoiceMediaType;
  /** sha256 of the uploaded file's bytes. */
  document_sha256: string | null;
  retained: boolean;
  facts: StoredFacts | null;
  /** Why the amount was read as "0" (refused by invoice.amount_invalid), or null. Kept in zero-retention mode too. */
  amount_issue: AmountIssue | null;
  status: InvoiceStatus;
  outcome: SpendOutcome | null;
  error: string | null;
  /** The cycle's anchor transaction; the ledger never holds it. */
  anchor_tx_hash: string | null;
  request_id: string;
  model_prompt_tokens: number | null;
  model_completion_tokens: number | null;
  created_by: string;
  created_at: string;
  decided_at: string | null;
}

export interface NewInvoice {
  invoiceHash: string;
  ref: string;
  filename: string | null;
  mediaType: InvoiceMediaType;
  documentSha256: string;
  /** The sealed file, or null in zero-retention mode (then `facts` and `filename` are null too). */
  sealed: Sealed | null;
  facts: StoredFacts | null;
  amountIssue: AmountIssue | null;
  /** sha256 of the normalised text (fingerprintText): the duplicate guard's key. */
  fingerprint: string;
  /** sha256 of "<tenant id>:<invoice number>", or null when the text states none. */
  invoiceNumberHash: string | null;
  requestId: string;
  createdBy: string;
}

export type InsertResult =
  | { id: string; duplicate: false; retry: boolean }
  | { id: string; duplicate: true; status: InvoiceStatus };

export function insertInvoice(db: Db, tenantId: string, i: NewInvoice): Promise<InsertResult> {
  return db.rpc<InsertResult>("invoice_insert", {
    tenant_id: tenantId,
    invoice_hash: i.invoiceHash,
    ref: i.ref,
    filename: i.filename,
    media_type: i.mediaType,
    document_sha256: i.documentSha256,
    fingerprint_sha256: i.fingerprint,
    invoice_number_sha256: i.invoiceNumberHash,
    retained: i.sealed !== null,
    content_ciphertext: i.sealed?.ciphertext ?? null,
    content_nonce: i.sealed?.nonce ?? null,
    facts: i.facts,
    amount_issue: i.amountIssue,
    request_id: i.requestId,
    created_by: i.createdBy,
  });
}

export type OutcomeRecord =
  | {
      status: "decided" | "unconfirmed";
      outcome: SpendOutcome;
      anchorTxHash: string | null;
      promptTokens: number | null;
      completionTokens: number | null;
    }
  | { status: "error"; error: string };

/** Compare-and-set on `processing`: `changed` is false when the row had already left it. */
export function setInvoiceOutcome(
  db: Db,
  tenantId: string,
  id: string,
  r: OutcomeRecord,
): Promise<{ id: string; status: InvoiceStatus; changed: boolean }> {
  return db.rpc("invoice_set_outcome", {
    tenant_id: tenantId,
    id,
    status: r.status,
    ...(r.status === "error"
      ? { outcome: null, error: r.error }
      : {
          outcome: r.outcome,
          error: null,
          anchor_tx_hash: r.anchorTxHash,
          model_prompt_tokens: r.promptTokens,
          model_completion_tokens: r.completionTokens,
        }),
  });
}

export function listInvoices(db: Db, tenantId: string, limit = 50): Promise<InvoiceRow[]> {
  return db.rpc<InvoiceRow[]>("invoice_list", { tenant_id: tenantId, limit });
}

/** Null when the id is not one of this tenant's invoices. A malformed id is a DbError `invalid_input`. */
export function getInvoice(db: Db, tenantId: string, id: string): Promise<InvoiceRow | null> {
  return db.rpc<InvoiceRow | null>("invoice_get", { tenant_id: tenantId, id });
}
