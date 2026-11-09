import type { InvoiceFacts } from "@probarion/core";
import type { SpendOutcome } from "@probarion/sdk";
import type { Sealed } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import type { InvoiceMediaType } from "./extract";
import type { AmountIssue } from "./facts";

// The invoices rows as the service-role functions of migration 0006 read and write them. `tenantId` must come
// from the session's membership (memberRole) or a server job's own tenant row, never from a request.

/**
 * received -> processing -> decided | unconfirmed | awaiting_owner | error (0006's check and functions).
 * awaiting_owner: no attested model confirmed the amount the code read, so nothing was sent; the owner confirms.
 * awaiting_owner -> processing (the owner confirmed, migration 0007) -> decided | unconfirmed | awaiting_owner.
 * awaiting_owner -> rejected (the owner rejected it, 0007): nothing was paid, and its guard keys are freed.
 */
export type InvoiceStatus =
  | "received"
  | "processing"
  | "decided"
  | "unconfirmed"
  | "awaiting_owner"
  | "error"
  | "rejected";

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
  /** The code's amount (USDC base units) the owner is asked to confirm; set only when awaiting_owner. */
  suggested_amount: string | null;
  outcome: SpendOutcome | null;
  error: string | null;
  /** The cycle's anchor transaction; the ledger never holds it. */
  anchor_tx_hash: string | null;
  /** The mandate the cycle signed under (migration 0007), or null for a row that never reached one. */
  mandate_id: number | null;
  /**
   * The owner's signed confirmation (0007): the account, the exact message the server built, the signer key, the
   * NEP-413 signature (base64), its nonce (hex), and the final block at which the key was read as FullAccess. All
   * set together, or all null.
   */
  confirmed_by: string | null;
  confirmed_at: string | null;
  confirm_message: string | null;
  confirm_public_key: string | null;
  confirm_signature: string | null;
  confirm_nonce: string | null;
  confirm_key_block_height: number | null;
  confirm_key_block_hash: string | null;
  /** Who rejected a waiting invoice, and when (0007). */
  rejected_by: string | null;
  rejected_at: string | null;
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
  /** HMAC of the vault, the payee and the invoice number (pipeline.ts invoiceNumberKey), or null when none. */
  invoiceNumberKey: string | null;
  requestId: string;
  createdBy: string;
}

/**
 * The earlier invoice of the same payee with the same invoice number, which may have paid or may still pay (migration
 * 0015): `outcome_status` is its SDK outcome's status, null while it has none.
 */
export interface NumberMatch {
  id: string;
  invoice_hash: string;
  status: InvoiceStatus;
  outcome_status: string | null;
}

export type InsertResult =
  | {
      id: string;
      duplicate: false;
      retry: boolean;
      /** Set with `numberRule` (0015): the earlier invoice with this number, or null. Absent before 0015 runs. */
      number_match?: NumberMatch | null;
    }
  | { id: string; duplicate: true; status: InvoiceStatus };

/**
 * `numberRule`: the caller refuses a same-number invoice in decide() itself (number-duplicate.ts), so a match on the
 * invoice-number key alone is inserted and named in `number_match` instead of answered as a duplicate. The same text
 * and the same fingerprint stay duplicates. Before migration 0015 the flag is ignored: a match is a duplicate.
 */
export function insertInvoice(
  db: Db,
  tenantId: string,
  i: NewInvoice,
  opts: { numberRule?: boolean } = {},
): Promise<InsertResult> {
  return db.rpc<InsertResult>("invoice_insert", {
    tenant_id: tenantId,
    invoice_hash: i.invoiceHash,
    ref: i.ref,
    filename: i.filename,
    media_type: i.mediaType,
    document_sha256: i.documentSha256,
    fingerprint_sha256: i.fingerprint,
    invoice_number_hmac: i.invoiceNumberKey,
    retained: i.sealed !== null,
    content_ciphertext: i.sealed?.ciphertext ?? null,
    content_nonce: i.sealed?.nonce ?? null,
    facts: i.facts,
    amount_issue: i.amountIssue,
    request_id: i.requestId,
    created_by: i.createdBy,
    ...(opts.numberRule ? { number_rule: true } : {}),
  });
}

export type OutcomeRecord =
  | {
      status: "decided" | "unconfirmed" | "awaiting_owner";
      outcome: SpendOutcome;
      /** The code's amount for the owner to confirm: required for awaiting_owner, null otherwise. */
      suggestedAmount?: string | null;
      /** The mandate the cycle signed under; left out or null keeps the one the row has (0007). */
      mandateId?: number | null;
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
          suggested_amount: r.suggestedAmount ?? null,
          mandate_id: r.mandateId ?? null,
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

// ---- the owner's confirmation and rejection (migration 0007, rulings W-T14-R0 and R1) --------------------------

/** What the owner saw: a confirmation nonce and a Reject are bound to exactly this snapshot of the waiting row. */
export interface RowSnapshot {
  suggestedAmount: string;
  invoiceHash: string;
  /** Null for a waiting row recorded without a mandate: it can be rejected, not confirmed. */
  mandateId: number | null;
}

export type IssueResult =
  | {
      ok: true;
      nonce: string;
      invoice_id: string;
      suggested_amount: string;
      mandate_id: number;
      invoice_hash: string;
      /** ISO-8601 UTC to the second, five minutes after the database's now. */
      expires_at: string;
    }
  | { ok: false; reason: "not_awaiting" | "no_mandate"; status: InvoiceStatus };

/** A confirmation nonce (32 bytes, hex) for this waiting row's snapshot, issued to `issuedTo`. */
export function issueConfirmNonce(
  db: Db,
  tenantId: string,
  id: string,
  nonce: string,
  issuedTo: string,
): Promise<IssueResult> {
  return db.rpc<IssueResult>("invoice_confirm_issue", {
    tenant_id: tenantId,
    id,
    nonce,
    issued_to: issuedTo,
  });
}

export interface ConfirmNonce {
  nonce: string;
  purpose: "confirm";
  tenant_id: string;
  invoice_id: string;
  issued_to: string;
  suggested_amount: string;
  mandate_id: number;
  invoice_hash: string;
  expires_at: string;
  used: boolean;
  expired: boolean;
}

/** The record of a confirmation nonce, so the server can rebuild the message it was issued for; null when unknown. */
export function readConfirmNonce(db: Db, nonce: string): Promise<ConfirmNonce | null> {
  return db.rpc<ConfirmNonce | null>("invoice_confirm_nonce", { nonce });
}

export interface BeginInput {
  tenantId: string;
  id: string;
  /** The nonce (hex) the signed message carries. */
  nonce: string;
  /** The session account: it must be the account the nonce was issued to. */
  account: string;
  /** The message the server rebuilt and verified the signature over. */
  message: string;
  publicKey: string;
  /** The 64 signature bytes, standard padded base64. */
  signature: string;
  /** The final block at which the key was read as a FullAccess key of the owner. */
  keyBlockHeight: number;
  keyBlockHash: string;
  /** The confirmed cycle's request id (written into its ledger entries). */
  requestId: string;
}

export type BeginRefusal =
  | "nonce_unknown"
  | "nonce_used"
  | "nonce_mismatch"
  | "expired"
  | "not_awaiting"
  | "row_changed"
  | "duplicate";

export type BeginResult =
  | { ok: true; status: "processing" }
  | {
      ok: false;
      reason: BeginRefusal;
      status?: InvoiceStatus;
      duplicate_id?: string;
      duplicate_status?: InvoiceStatus;
    };

/**
 * One transaction: burn the nonce, re-check that it was issued to this account for this row of this tenant and has
 * not expired, re-run the duplicate guard, and compare-and-set the row from awaiting_owner (with the nonce's
 * snapshot) to processing, recording the confirmation. Every refusal leaves the row as it was; the nonce is burned
 * by any attempt that names it.
 */
export function beginConfirmation(db: Db, i: BeginInput): Promise<BeginResult> {
  return db.rpc<BeginResult>("invoice_confirm_begin", {
    tenant_id: i.tenantId,
    id: i.id,
    nonce: i.nonce,
    account: i.account,
    message: i.message,
    public_key: i.publicKey,
    signature: i.signature,
    key_block_height: i.keyBlockHeight,
    key_block_hash: i.keyBlockHash,
    request_id: i.requestId,
  });
}

/** Burns an unused nonce on its own (after a signature that did not verify). `burned` is false when it was not live. */
export function burnConfirmNonce(db: Db, nonce: string): Promise<{ burned: boolean }> {
  return db.rpc<{ burned: boolean }>("invoice_confirm_burn", { nonce });
}

/**
 * Sends a confirmed row back to awaiting_owner when its cycle stopped before anything was sent (the SDK threw). Only
 * a row that a confirmation moved to processing, and that has no outcome of that cycle yet.
 */
export function abortConfirmation(
  db: Db,
  tenantId: string,
  id: string,
): Promise<{ changed: boolean; status: InvoiceStatus }> {
  return db.rpc("invoice_confirm_abort", { tenant_id: tenantId, id });
}

/**
 * Reject: awaiting_owner -> rejected, compare-and-set on the snapshot the owner saw. Nothing is paid, and the row's
 * guard keys are freed, so a corrected re-upload is a new invoice.
 */
export function setInvoiceRejected(
  db: Db,
  tenantId: string,
  id: string,
  rejectedBy: string,
  seen: RowSnapshot,
): Promise<{ changed: boolean; status: InvoiceStatus }> {
  return db.rpc("invoice_reject", {
    tenant_id: tenantId,
    id,
    rejected_by: rejectedBy,
    suggested_amount: seen.suggestedAmount,
    invoice_hash: seen.invoiceHash,
    mandate_id: seen.mandateId,
  });
}

/** A retained invoice's sealed file, for the owner's review on the server; null in zero-retention mode. */
export async function invoiceContent(
  db: Db,
  tenantId: string,
  id: string,
): Promise<{ mediaType: InvoiceMediaType; sealed: Sealed } | null> {
  const r = await db.rpc<{
    media_type: InvoiceMediaType;
    content_ciphertext: string;
    content_nonce: string;
  } | null>("invoice_content", { tenant_id: tenantId, id });
  return r === null
    ? null
    : {
        mediaType: r.media_type,
        sealed: { ciphertext: r.content_ciphertext, nonce: r.content_nonce },
      };
}

const PAYEE_PAGE = 500;

/**
 * Every invoice of the tenant from the last 90 days under one of these mandates (a payee's mandates), or that holds a
 * ledger decision under one of them, newest first. No cap on the total: it reads page by page until a page comes back
 * short, so "no other invoice of this payee" is true when it says so (ruling W-T14-R2).
 */
export async function listPayeeRecent(
  db: Db,
  tenantId: string,
  mandateIds: readonly number[],
  pageSize: number = PAYEE_PAGE,
): Promise<InvoiceRow[]> {
  const all: InvoiceRow[] = [];
  let after: { created_at: string; id: string } | null = null;
  for (;;) {
    const page: InvoiceRow[] = await db.rpc<InvoiceRow[]>("invoice_payee_recent", {
      tenant_id: tenantId,
      mandate_ids: mandateIds,
      limit: pageSize,
      ...(after === null ? {} : { after }),
    });
    all.push(...page);
    const last = page.at(-1);
    if (last === undefined || page.length < pageSize) return all;
    after = { created_at: last.created_at, id: last.id };
  }
}
