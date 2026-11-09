import "server-only";
import {
  type CheckSpendVerdict,
  describePayee,
  isPositiveAmount,
  type MandateView,
  payeeHintContradiction,
  type SpendRequest,
  ZERO_HEX32,
} from "@probarion/core";
import { hashInvoice } from "@probarion/sdk";
import { mandateState, remainingUnits } from "@/lib/console/mandates-view";
import { sealInvoice } from "@/lib/crypto/secrets";
import { sha256Hex } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import type { MemberTenant } from "@/lib/db/tenants";
import { listKeys } from "@/lib/keys/list";
import { log } from "@/lib/log";
import { payeeText } from "./confirm-message";
import { extractInvoice } from "./extract";
import { type AmountIssue, extractFacts, fingerprintText, refFor } from "./facts";
import { invoiceNumberKey } from "./number-key";
import {
  CHECK_SPEND_RULE,
  EXTENSION_MANDATE_RULE,
  PAYEE_RULE,
  type QueueCheck,
} from "./queue-rules";
import { type InvoiceStatus, queueInvoiceRow } from "./store";
import type { InvoiceUpload } from "./upload";

// The browser extension's intake (spec §4.4). An invoice is read and checked as the console upload reads it, then
// stored in awaiting_owner for the owner's wallet-signed Confirm (confirm.ts), the only way it is ever paid. Nothing
// here calls a model, opens a key or sends a transaction, and test/ext-structure.test.ts holds it to that.
//
// No tenant lease: nothing is sent, the row only waits. Two copies of one invoice that pass the duplicate guard at
// the same instant both wait, and Confirm's own guard (0007's invoice_confirm_begin) refuses the second once the
// first is paid or being paid.

export interface QueueDeps {
  db: Db;
  master: Uint8Array;
  /** Every mandate of the tenant's vault, as the chain shows it now. */
  mandates(tenant: MemberTenant): Promise<MandateView[]>;
  /** The contract's free check_spend view, read through a VaultClient that holds no key. */
  checkSpend(
    tenant: MemberTenant,
    request: SpendRequest,
    signerPk: string,
  ): Promise<CheckSpendVerdict>;
  now?: () => Date;
}

export interface QueueInput {
  tenant: MemberTenant;
  upload: InvoiceUpload;
  /** The mandate the member chose in the extension. */
  mandateId: number;
  /** The token's account, recorded as the row's created_by. */
  actor: string;
  requestId: string;
}

export type QueueResult =
  | { status: "queued"; invoiceId: string }
  | { status: "duplicate"; invoiceId: string; invoiceStatus: InvoiceStatus }
  | { status: "empty" }
  | { status: "amount_unclear"; issue: AmountIssue | null }
  | { status: "chain_unavailable" }
  | { status: "mandate_not_found" }
  | { status: "mandate_inactive"; reason: string }
  | { status: "no_keys"; missing: ("agent" | "ledger")[] }
  | { status: "refused"; rule: string; detail: string };

/**
 * Why a mandate cannot take an invoice now, in the words the 422 shows, or null. It refuses exactly the mandates the
 * extension's inbox leaves out (lib/ext/inbox.ts: usableRemaining and its payee filter), and queue.test.ts holds the
 * two to one result. A payee the confirmation message cannot name would leave a row the owner can only reject.
 */
export function mandateProblem(m: MandateView, now: Date): string | null {
  const state = mandateState(m, now.getTime()).key;
  if (state === "unknown") return `mandate ${m.id}'s status or expiry cannot be read`;
  if (state !== "active") return `mandate ${m.id} is ${state}`;
  if (typeof m.uses !== "number" || typeof m.max_uses !== "number") {
    return `mandate ${m.id}'s uses cannot be read`;
  }
  if (m.uses >= m.max_uses) return `mandate ${m.id} has no uses left`;
  const left = remainingUnits(m);
  if (left === null) return `mandate ${m.id}'s total cannot be read`;
  if (left === "0") return `mandate ${m.id} has nothing left of its total`;
  try {
    payeeText(m.payee);
  } catch {
    return `mandate ${m.id}'s payee is not in a form Confirm can sign`;
  }
  return null;
}

export async function queueInvoice(deps: QueueDeps, input: QueueInput): Promise<QueueResult> {
  const { tenant, upload, requestId } = input;
  const at = { request_id: requestId, tenant: tenant.tenant_id, vault: tenant.vault_id };
  const now = (deps.now ?? (() => new Date()))();

  // 1. The text, and its hash: the invoice hash is never the file hash.
  const { text, truncated } = await extractInvoice(upload);
  if (text.trim() === "") return { status: "empty" };
  const invoiceHash = hashInvoice(text);

  // 2. The facts. No purpose document comes with it: the member chose the mandate instead (D3). Confirm pays the
  //    suggested amount, so an amount the code cannot read as one positive total stops here.
  const { invoiceNumber, amountIssue, ...facts } = extractFacts(text, invoiceHash, null, {
    truncated: truncated !== null,
  });
  if (amountIssue !== null || !isPositiveAmount(facts.amount)) {
    return { status: "amount_unclear", issue: amountIssue };
  }

  // 3. The chosen mandate, as the chain shows it now.
  let mandates: MandateView[];
  try {
    mandates = await deps.mandates(tenant);
  } catch (error) {
    log.warn("payables.queue_chain_unavailable", { ...at, error });
    return { status: "chain_unavailable" };
  }
  const mandate = mandates.find((m) => m.id === input.mandateId);
  if (mandate === undefined) return { status: "mandate_not_found" };
  const inactive = mandateProblem(mandate, now);
  if (inactive !== null) return { status: "mandate_inactive", reason: inactive };

  // 4. The keys Confirm will sign with, listed and never opened: the mandate's agent key and the ledger key.
  const keys = await listKeys(deps.db, tenant.tenant_id);
  const active = (purpose: "agent" | "ledger", publicKey?: string) =>
    keys.some(
      (k) =>
        k.purpose === purpose &&
        k.status === "active" &&
        (publicKey === undefined || k.public_key === publicKey),
    );
  const missing: ("agent" | "ledger")[] = [];
  if (!active("agent", mandate.agent_pk)) missing.push("agent");
  if (!active("ledger")) missing.push("ledger");
  if (missing.length > 0) return { status: "no_keys", missing };

  // 5. The code's checks. A refusal stores nothing.
  const contradiction = payeeHintContradiction(facts.payee_hint, mandate.payee);
  if (contradiction !== null) return { status: "refused", rule: PAYEE_RULE, detail: contradiction };
  const ref = refFor(invoiceHash);
  let verdict: CheckSpendVerdict;
  try {
    verdict = await deps.checkSpend(
      tenant,
      {
        mandate_id: mandate.id,
        amount: facts.amount,
        invoice_hash: invoiceHash,
        ref,
        decision_hash: ZERO_HEX32,
      },
      mandate.agent_pk,
    );
  } catch (error) {
    log.warn("payables.queue_chain_unavailable", { ...at, error });
    return { status: "chain_unavailable" };
  }
  if (!verdict.ok) {
    return {
      status: "refused",
      rule: CHECK_SPEND_RULE,
      detail: `the vault would refuse this payment now (${verdict.code ?? "no code given"})`,
    };
  }
  const checks: QueueCheck[] = [
    {
      id: EXTENSION_MANDATE_RULE,
      outcome: "hold",
      detail: `${input.actor} chose mandate ${mandate.id} in the browser extension. No purpose document was matched, so only the owner's signed Confirm can pay it.`,
    },
    {
      id: PAYEE_RULE,
      outcome: "pass",
      // One wording for every invoice: a zero-retention row keeps this detail too, so it must not say whether the
      // invoice named a payee (/privacy: such a row keeps none of the invoice's other facts).
      detail: `The invoice's payee, if it names one, does not contradict the mandate's (${describePayee(mandate.payee)}).`,
    },
    {
      id: CHECK_SPEND_RULE,
      outcome: verdict.would_hold ? "hold" : "pass",
      detail: verdict.would_hold
        ? "The vault would hold this payment for its approvers: it is above the mandate's approval limit."
        : "The vault would accept this payment now.",
    },
  ];

  // 6. The row: the console upload's fields, guard and retention, straight in awaiting_owner.
  const zero = tenant.zero_retention;
  const r = await queueInvoiceRow(deps.db, tenant.tenant_id, {
    invoiceHash,
    ref,
    filename: zero ? null : upload.filename,
    mediaType: upload.mediaType,
    documentSha256: sha256Hex(upload.bytes),
    sealed: zero ? null : await sealInvoice(deps.master, tenant.tenant_id, upload.bytes),
    facts: zero ? null : { ...facts, invoice_number: invoiceNumber },
    amountIssue: null,
    fingerprint: sha256Hex(fingerprintText(text)),
    invoiceNumberKey:
      invoiceNumber === null
        ? null
        : invoiceNumberKey(deps.master, tenant.vault_id, mandate.payee, invoiceNumber),
    requestId,
    createdBy: input.actor,
    suggestedAmount: facts.amount,
    mandateId: mandate.id,
    checks,
  });
  if (r.duplicate) return { status: "duplicate", invoiceId: r.id, invoiceStatus: r.status };
  log.info("payables.queued", {
    ...at,
    invoice: r.id,
    mandate_id: mandate.id,
    amount: facts.amount,
    by: input.actor,
  });
  return { status: "queued", invoiceId: r.id };
}
