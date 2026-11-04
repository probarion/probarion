import "server-only";
import { createHmac, hkdfSync } from "node:crypto";
import type { CustomRule, InvoiceFacts, MandateView, Payee, RuleResult } from "@probarion/core";
import { hashInvoice, type SpendOutcome } from "@probarion/sdk";
import { sealInvoice } from "@/lib/crypto/secrets";
import { DecryptError, sha256Hex } from "@/lib/crypto/sodium";
import { type Db, DbError } from "@/lib/db/port";
import { type MemberTenant, withLease } from "@/lib/db/tenants";
import {
  KeyMismatchError,
  listKeys,
  loadActiveSecret,
  loadActiveSecretFor,
} from "@/lib/keys/service";
import { log, scrubText } from "@/lib/log";
import { extractInvoice, type InvoiceMediaType } from "./extract";
import { type AmountIssue, extractFacts, fingerprintText, numberKeyText, refFor } from "./facts";
import { signingMandate } from "./mandate";
import { OWNER_CONFIRMS_RULE, ownerConfirms } from "./owner-confirms";
import { type InvoiceStatus, insertInvoice, setInvoiceOutcome } from "./store";

// The Payables cycle (spec §8, plan 04 Task 13): extract the invoice text, read its facts, store it sealed or as
// hashes only, and run `Probarion.process()` with the agent key the mandate is bound to. The code decides, the
// contract enforces; this file only feeds them and records what they did.

/**
 * How long one cycle holds the tenant's `process` lease. It must outlast the longest cycle (the route's
 * `maxDuration`, 60 s) with a margin: the lease fence stops a late release, not an overrun that overlaps the next
 * cycle. route.test.ts checks it against the route's `maxDuration`.
 */
export const PROCESS_LEASE_SECONDS = 90;

/** What the pipeline needs from the SDK's `Probarion` (and what tests fake). */
export interface ProbarionLike {
  process(invoice: { text: string; facts: InvoiceFacts; ref: string }): Promise<SpendOutcome>;
  /**
   * The SDK's custom rules: the pipeline adds the rule that the owner confirms the amount unless an attested model
   * does (owner-confirms.ts).
   */
  rules: { add(rule: CustomRule): void };
}

export interface PipelineDeps {
  db: Db;
  master: Uint8Array;
  /** Every mandate of the tenant's vault, as the chain shows it now. */
  mandates(tenant: MemberTenant): Promise<MandateView[]>;
  makeProbarion(o: {
    tenant: MemberTenant;
    agentKey: string;
    ledgerKey: string;
    requestId: string;
  }): ProbarionLike;
  /** The clock the mandate pre-selection uses (default: now). Give the SDK the same one. */
  now?: () => Date;
}

export interface InvoiceUpload {
  bytes: Uint8Array;
  mediaType: InvoiceMediaType;
  filename: string | null;
}

/** Why a key could not be used. None of them is ever answered with another key. */
export type KeyProblem = "inactive" | "decrypt_failed" | "key_mismatch";

export type PipelineResult =
  /**
   * The cycle ran. `invoiceStatus` "unconfirmed": the payment was sent and its confirmation is pending.
   * "awaiting_owner": no attested model confirmed the amount the code read, so nothing was sent; the row keeps the code's
   * amount as a suggestion for the owner to confirm.
   */
  | {
      status: "decided";
      invoiceId: string;
      invoiceStatus: "decided" | "unconfirmed" | "awaiting_owner";
      outcome: SpendOutcome;
      /** False when the outcome could not be written to the invoice row (it stays `processing`). */
      recorded: boolean;
      /** Why the code read the amount as "0" (the policy then refuses it), or null when it read one. */
      amountIssue: AmountIssue | null;
    }
  | { status: "duplicate"; invoiceId: string; invoiceStatus: InvoiceStatus }
  | { status: "busy" }
  | { status: "no_keys"; missing: ("agent" | "ledger")[] }
  /** No mandate has the invoice's purpose (or the invoice came without its purpose document). */
  | { status: "no_mandate"; purposeHash: string | null }
  | {
      status: "key_unavailable";
      purpose: "agent" | "ledger";
      reason: KeyProblem;
      mandateId: number | null;
      /** The key that would have signed (public, as the chain shows it), or null for the ledger key. */
      publicKey: string | null;
    }
  /** The vault's mandates could not be read; nothing was stored or sent. */
  | { status: "chain_unavailable" }
  | { status: "empty" }
  /** The cycle threw before any spend was sent; the invoice row says `error` and may be run again. */
  | { status: "failed"; invoiceId: string; error: string };

export interface PipelineInput {
  tenant: MemberTenant;
  upload: InvoiceUpload;
  /** The PO or contract document whose sha256 is the mandate's `purpose_hash`; null when none was attached. */
  purposeBytes: Uint8Array | null;
  actor: string;
  requestId: string;
}

type Opened = { key: { publicKey: string; secret: string } } | { problem: KeyProblem };

/** The key, or why it cannot be used (null, decrypt_failed and key_mismatch are a skipped cycle). */
async function openKey(
  load: () => Promise<{ publicKey: string; secret: string } | null>,
): Promise<Opened> {
  try {
    const key = await load();
    return key ? { key } : { problem: "inactive" };
  } catch (e) {
    if (e instanceof DecryptError) return { problem: "decrypt_failed" };
    if (e instanceof KeyMismatchError) return { problem: "key_mismatch" };
    // A mandate bound to a key this console cannot hold (not an ed25519 key): no secret exists for it.
    if (e instanceof DbError && e.code === "invalid_input") return { problem: "inactive" };
    throw e;
  }
}

const messageOf = (e: unknown): string =>
  scrubText(e instanceof Error ? e.message : String(e)).slice(0, 500) || "unknown error";

/** The HKDF label of the invoice-number key: a key of its own, derived from KEY_ENCRYPTION_SECRET. */
const NUMBER_KEY_INFO = "probarion/payables/invoice-number-key/v1";

/** The payee as one string: a NEAR account, or an Intents chain, address and asset. */
const payeeId = (p: Payee): string =>
  (p.type === "near"
    ? `near:${p.account_id}`
    : `intents:${p.chain}:${p.address}:${p.asset}`
  ).toLowerCase();

/**
 * The duplicate guard's second key: HMAC-SHA256, under a server-side key derived from the master key with HKDF, of
 * the vault, the mandate's payee and the invoice number (its skeleton, so case and look-alikes do not matter).
 * Keyed, so the zero-retention mode keeps nothing a member could enumerate back to the number; scoped by payee, so
 * two vendors' "#1001" do not block each other.
 */
export function invoiceNumberKey(
  master: Uint8Array,
  vault: string,
  payee: Payee,
  invoiceNumber: string,
): string {
  const key = Buffer.from(hkdfSync("sha256", master, new Uint8Array(0), NUMBER_KEY_INFO, 32));
  return createHmac("sha256", key)
    .update(`${vault}\n${payeeId(payee)}\n${numberKeyText(invoiceNumber)}`)
    .digest("hex");
}

/** A NEAR transaction hash (base58): anything else stays in `outcome` but not in the anchor column. */
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

/**
 * The invoice status for an SDK outcome. "unconfirmed", and any status this code does not know (the
 * `default:` arm), may have paid: it is recorded as `unconfirmed`, shown as "payment sent, confirmation
 * pending" and never sent again (the SDK's UNKNOWN_SETTLE_MS guard and rule `ledger.unresolved` hold it).
 */
export function invoiceStatusOf(outcome: Pick<SpendOutcome, "status">): "decided" | "unconfirmed" {
  switch (outcome.status) {
    case "refused_by_code":
    case "refused_by_contract":
    case "held":
    case "paid":
    case "burned":
    case "settled":
    case "failed":
      return "decided";
    default:
      return "unconfirmed";
  }
}

/**
 * True when nothing was sent and the owner-confirms rule held or refused the cycle: the invoice waits for the
 * owner. `owner` is the rule's own verdict in this cycle (null when it did not run). A hold counts when another
 * rule held first (intents.balance_low, model.low_confidence) and the owner rule held too; a refusal counts only
 * when it is the owner rule's (another rule's refusal stands). Any other outcome is recorded as decided.
 */
export function waitsForOwner(
  outcome: Pick<SpendOutcome, "status" | "code" | "spendId" | "txHash">,
  owner: RuleResult["outcome"] | null = null,
): boolean {
  if (outcome.spendId !== null || outcome.txHash !== null) return false;
  if (outcome.code === OWNER_CONFIRMS_RULE) {
    return outcome.status === "held" || outcome.status === "refused_by_code";
  }
  return outcome.status === "held" && owner === "hold";
}

export async function processInvoice(
  deps: PipelineDeps,
  input: PipelineInput,
): Promise<PipelineResult> {
  const { tenant, upload, requestId } = input;
  const at = { request_id: requestId, tenant: tenant.tenant_id, vault: tenant.vault_id };
  const now = (deps.now ?? (() => new Date()))();

  // The text the model is shown, and its hash: the invoice hash is never the file hash.
  const { text, truncated } = await extractInvoice(upload);
  if (text.trim() === "") return { status: "empty" };
  const invoiceHash = hashInvoice(text);
  const purposeHash =
    input.purposeBytes !== null && input.purposeBytes.length > 0
      ? sha256Hex(input.purposeBytes)
      : null;
  // Only the five InvoiceFacts keys reach the SDK; the invoice number is kept for display.
  // A text cut short (more pages than are read, or past the length limit) gives the amount "0": its final total
  // may be on the part that was not read.
  const { invoiceNumber, amountIssue, ...facts } = extractFacts(text, invoiceHash, purposeHash, {
    truncated: truncated !== null,
  });
  const ref = refFor(invoiceHash);

  const keyUnavailable = (
    purpose: "agent" | "ledger",
    reason: KeyProblem,
    mandate: MandateView | null,
  ): PipelineResult => {
    // One event per skipped cycle, for the owner's alerts: which tenant, vault and mandate, never key material.
    log.error("payables.key_unavailable", {
      ...at,
      mandate_id: mandate?.id ?? null,
      key_purpose: purpose,
      reason,
    });
    return {
      status: "key_unavailable",
      purpose,
      reason,
      mandateId: mandate?.id ?? null,
      publicKey: mandate?.agent_pk ?? null,
    };
  };

  const ledger = await openKey(() =>
    loadActiveSecret(deps.db, deps.master, tenant.tenant_id, "ledger"),
  );
  const activeAgentKeys = new Set(
    (await listKeys(deps.db, tenant.tenant_id))
      .filter((k) => k.purpose === "agent" && k.status === "active")
      .map((k) => k.public_key),
  );
  const missing: ("agent" | "ledger")[] = [];
  if (activeAgentKeys.size === 0) missing.push("agent");
  if ("problem" in ledger && ledger.problem === "inactive") missing.push("ledger");
  if (missing.length > 0) return { status: "no_keys", missing };
  if ("problem" in ledger) return keyUnavailable("ledger", ledger.problem, null);

  let mandates: MandateView[];
  try {
    mandates = await deps.mandates(tenant);
  } catch (e) {
    log.warn("payables.chain_unavailable", { ...at, error: messageOf(e) });
    return { status: "chain_unavailable" };
  }
  // The mandate decides the key: the payment signs with mandate.agent_pk, or the cycle does not run.
  const mandate = signingMandate(mandates, purposeHash, now, activeAgentKeys);
  if (mandate === null) return { status: "no_mandate", purposeHash };
  const agent = await openKey(() =>
    loadActiveSecretFor(deps.db, deps.master, tenant.tenant_id, mandate.agent_pk),
  );
  if ("problem" in agent) return keyUnavailable("agent", agent.problem, mandate);

  const leased = await withLease(
    deps.db,
    tenant.tenant_id,
    "process",
    PROCESS_LEASE_SECONDS,
    async (): Promise<PipelineResult> => {
      const zero = tenant.zero_retention;
      const inserted = await insertInvoice(deps.db, tenant.tenant_id, {
        invoiceHash,
        ref,
        filename: zero ? null : upload.filename, // a file name can carry details
        mediaType: upload.mediaType,
        documentSha256: sha256Hex(upload.bytes),
        sealed: zero ? null : await sealInvoice(deps.master, tenant.tenant_id, upload.bytes),
        facts: zero ? null : { ...facts, invoice_number: invoiceNumber },
        amountIssue,
        // The duplicate guard: another text that renders the same invoice, or the same number for the same payee.
        fingerprint: sha256Hex(fingerprintText(text)),
        invoiceNumberKey:
          invoiceNumber === null
            ? null
            : invoiceNumberKey(deps.master, tenant.vault_id, mandate.payee, invoiceNumber),
        requestId,
        createdBy: input.actor,
      });
      if (inserted.duplicate) {
        return { status: "duplicate", invoiceId: inserted.id, invoiceStatus: inserted.status };
      }

      let outcome: SpendOutcome;
      // The owner confirms the amount unless an attested model does: without that, nothing is sent.
      const owner = ownerConfirms();
      try {
        const pb = deps.makeProbarion({
          tenant,
          agentKey: agent.key.secret,
          ledgerKey: ledger.key.secret,
          requestId,
        });
        pb.rules.add(owner.rule);
        outcome = await pb.process({ text, facts, ref });
      } catch (e) {
        // The SDK sends a spend only after a decision and never throws once it has: nothing went out.
        const error = messageOf(e);
        log.error("payables.failed", {
          ...at,
          invoice: inserted.id,
          mandate_id: mandate.id,
          error,
        });
        try {
          await setInvoiceOutcome(deps.db, tenant.tenant_id, inserted.id, {
            status: "error",
            error,
          });
        } catch (writeError) {
          log.error("payables.outcome_not_recorded", {
            ...at,
            invoice: inserted.id,
            error: messageOf(writeError),
          });
        }
        return { status: "failed", invoiceId: inserted.id, error };
      }

      const invoiceStatus = waitsForOwner(outcome, owner.outcome())
        ? "awaiting_owner"
        : invoiceStatusOf(outcome);
      const fields = {
        ...at,
        invoice: inserted.id,
        mandate_id: mandate.id,
        status: outcome.status,
        code: outcome.code,
        spend_id: outcome.spendId,
        tx: outcome.txHash,
        anchor_tx: outcome.anchorTxHash ?? null,
        amount_issue: amountIssue,
      };
      let recorded = false;
      try {
        // The payment may have gone out: whatever happens to this write, the outcome is returned, never an error.
        const r = await setInvoiceOutcome(deps.db, tenant.tenant_id, inserted.id, {
          status: invoiceStatus,
          outcome,
          // The code's amount, kept for the owner to confirm (Task 14's Confirm button).
          suggestedAmount: invoiceStatus === "awaiting_owner" ? facts.amount : null,
          anchorTxHash:
            outcome.anchorTxHash && TX_HASH.test(outcome.anchorTxHash)
              ? outcome.anchorTxHash
              : null,
          promptTokens: outcome.modelUsage?.promptTokens ?? null,
          completionTokens: outcome.modelUsage?.completionTokens ?? null,
        });
        recorded = r.changed;
        if (!r.changed) log.error("payables.outcome_not_recorded", { ...fields, row: r.status });
      } catch (e) {
        log.error("payables.outcome_not_recorded", { ...fields, error: messageOf(e) });
      }
      log.info("payables.decided", fields);
      return {
        status: "decided",
        invoiceId: inserted.id,
        invoiceStatus,
        outcome,
        recorded,
        amountIssue,
      };
    },
  );
  return leased.acquired ? leased.value : { status: "busy" };
}
