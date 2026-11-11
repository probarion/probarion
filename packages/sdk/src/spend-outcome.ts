// How one `spend` answer becomes a SpendOutcome and a payment entry (task-13 carries C2, ruling T13-R1).
// `spend` is sent exactly once per decision: nothing here ever sends again. An answer that might have paid
// is never reported as refused or failed.
import type {
  Decision,
  Hex32,
  LedgerEntry,
  LedgerEntryBody,
  Payee,
  RuleResult,
  SpendRequest,
  SpendResult,
  SpendStatus,
  SpendView,
} from "@probarion/core";
import {
  ConfigError,
  isVaultErrorCode,
  ProbarionError,
  TxOutcomeUnknownError,
  TxRejectedError,
} from "./errors.js";
import { messageOf } from "./input.js";
import { isOutOfNearCode, type TxOutcome } from "./tx.js";
import type { SpendTxResult, VaultClient } from "./vault-client.js";

export type SpendOutcomeStatus =
  | "refused_by_code"
  | "refused_by_contract"
  | "held"
  | "paid"
  | "burned"
  | "settled"
  | "failed"
  | "unconfirmed";

export interface ModelUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * What one cycle came to (interfaces §9, ICR-6).
 *
 * - `refused_by_code`: `code` is the first refusing `RuleId`. Nothing was sent.
 * - `refused_by_contract`: `code` is the bare vault code. `txHash` is null after a `check_spend` refusal
 *   (nothing was sent) and the failed transaction's hash after a `spend` panic.
 * - `held`: with `spendId` the contract holds the spend for an approver; with `spendId` null the code held
 *   it off-chain (`code` is the holding `RuleId`) and nothing was sent.
 * - `paid`, `burned`: settled on NEAR. A burn is not `settled` yet: the bridge releases it on Base or Solana, and
 *   Probarion does not watch that release yet, so `process` never returns `settled` and `burned` never changes.
 * - `failed`: definitely not paid. `code` is the payout status (`failed`, ...) when the vault released the
 *   spend, else why the transaction did not run (`TxSendFailed`, a `TxRejectedError` kind such as
 *   `NotEnoughAllowance`, `LackBalanceForState` / `NotEnoughBalance`, `TxFailed`).
 * - `unconfirmed`: `spend` was sent and may have paid. `txHash` is set whenever the sender knows it. Never
 *   send it again, least of all under a fresh `ref`: find the spend by `ref` in the vault's spends
 *   (`VaultClient.listAllSpends()`; `spends.get` takes a spend id, and the contract has no lookup by ref) or wait. Until
 *   the chain shows the spend, or until `UNKNOWN_SETTLE_MS` (48 h, the transaction validity window plus a
 *   margin) has passed, this instance refuses the same invoice by code. `code` says what is unknown (`TxOutcomeUnknown`, `pending`, `callback_failed`,
 *   `unreadable_value`, or `DuplicateRef` / `DuplicateInvoice` when no spend could be found by ref).
 *
 * Two identical calls can both report the same `spendId` paid by ONE payment (identical decisions, two
 * writers): consumers dedupe by `spendId` and never count two successes as two payments.
 */
export interface SpendOutcome {
  status: SpendOutcomeStatus;
  spendId: number | null;
  /** RuleId for code outcomes, the bare vault code for contract outcomes. */
  code: string | null;
  txHash: string | null;
  /** The seq of the last entry written in the cycle. */
  ledgerSeq: number;
  decisionHash: Hex32;
  /** The model id and token counts when the model answered, else null. */
  modelUsage?: ModelUsage | null;
  /** This cycle's anchor tx, null when the anchor failed or was not needed. Returned only, never stored in an entry. */
  anchorTxHash: string | null;
  /**
   * Set (to false) only when the payment entry of this cycle could not be written: the outcome stands, the
   * chain keeps the spend and its decision_hash, but the local ledger lacks the outcome entry.
   */
  ledgerComplete?: false;
}

export type OutcomeFields = Pick<SpendOutcome, "status" | "spendId" | "code" | "txHash">;

type SettledStatus = "paid" | "burned" | "held";

function isSettled(status: SpendResult["status"]): status is SettledStatus {
  return status === "paid" || status === "burned" || status === "held";
}

/** A spend that holds its invoice (the contract's DuplicateInvoice check, checks.rs:56). */
const RELEASED: ReadonlySet<SpendStatus> = new Set(["failed", "rejected", "expired"]);

type DuplicateCode = "DuplicateRef" | "DuplicateInvoice";

/** What one `spend` call came to, read from the sender's answer (task-13 carries C2). */
export type SpendRead =
  | {
      kind: "ok";
      result: { spend_id: number; status: SettledStatus };
      txHash: string | null;
      /** Set when the answer was DuplicateRef/DuplicateInvoice and this decision's spend was found by ref (C2 d). */
      byRef: { code: DuplicateCode; answeredTxHash: string | null } | null;
    }
  | {
      kind: "unknown";
      txHash: string | null;
      spendId: number | null;
      code: string;
      contractCode: string | null;
      why: string;
    }
  | { kind: "refused"; txHash: string | null; code: string; detail: string }
  | {
      kind: "failed";
      txHash: string | null;
      entryTxHash: string | null;
      spendId: number | null;
      /** True when the contract accepted the spend and released it after its payout failed. */
      released: boolean;
      entryStatus: string;
      entryCode: string | null;
      code: string;
      detail: string;
    };

export function refusal(detail: string): RuleResult {
  return { id: "contract.check_failed", outcome: "refuse", detail };
}

/** The node refused the signed transaction, or it could not be sent: nothing ran, nothing was paid. */
function notRun(code: string, detail: string): SpendRead {
  return {
    kind: "failed",
    txHash: null,
    entryTxHash: null,
    spendId: null,
    released: false,
    entryStatus: "failed",
    entryCode: code,
    code,
    detail,
  };
}

/** The spend receipt itself failed without a vault code (out of NEAR, out of gas, ...): nothing was paid. */
function definite(tx: TxOutcome, code: string, detail: string): SpendRead {
  return {
    kind: "failed",
    txHash: tx.txHash,
    entryTxHash: tx.txHash,
    spendId: null,
    released: false,
    entryStatus: "failed",
    entryCode: code,
    code,
    detail,
  };
}

/**
 * Sends `spend` once and reads the answer (C2): `ok` first, then `unconfirmed`, then the definite failures.
 * It never sends again: an unknown outcome stays unknown, and a duplicate answer is looked up by ref.
 */
export async function sendSpend(vault: VaultClient, request: SpendRequest): Promise<SpendRead> {
  let sent: SpendTxResult;
  try {
    sent = await vault.spend(request);
  } catch (error) {
    if (error instanceof TxOutcomeUnknownError) {
      return {
        kind: "unknown",
        txHash: error.txHash,
        spendId: null,
        code: "TxOutcomeUnknown",
        contractCode: null,
        why: error.message,
      };
    }
    if (error instanceof TxRejectedError) return notRun(error.kind, error.message);
    if (error instanceof ConfigError) throw error;
    if (error instanceof ProbarionError && error.code === "TxSendFailed") {
      return notRun("TxSendFailed", error.message);
    }
    // A sender this SDK does not know failed: it may have sent the transaction, so the outcome is unknown.
    return {
      kind: "unknown",
      txHash: null,
      spendId: null,
      code: "TxOutcomeUnknown",
      contractCode: null,
      why: messageOf(error),
    };
  }
  const { tx, result } = sent;
  if (sent.ok) {
    if (result !== null && isSettled(result.status)) {
      const settled = { spend_id: result.spend_id, status: result.status };
      return { kind: "ok", result: settled, txHash: tx.txHash, byRef: null };
    }
    // interpretSpend never says ok without a settled status; if it ever did, it may have paid.
    return {
      kind: "unknown",
      txHash: tx.txHash,
      spendId: result?.spend_id ?? null,
      code: "unreadable_value",
      contractCode: null,
      why: `the answer says ok without a paid, burned or held status (${String(result?.status)})`,
    };
  }
  if (sent.unconfirmed !== null) {
    return {
      kind: "unknown",
      txHash: tx.txHash,
      spendId: result?.spend_id ?? null,
      code: sent.unconfirmed.kind,
      contractCode: null,
      why: sent.unconfirmed.reason,
    };
  }
  if (result !== null) {
    // The contract took the spend and released it after the payout failed (failed, rejected, expired).
    return {
      kind: "failed",
      txHash: tx.txHash,
      entryTxHash: tx.txHash,
      spendId: result.spend_id,
      released: true,
      entryStatus: result.status,
      entryCode: null,
      code: result.status,
      detail: `the payout of spend ${result.spend_id} ended ${result.status}; the vault released the reservation`,
    };
  }
  if (tx.code === "DuplicateRef" || tx.code === "DuplicateInvoice") {
    return lookUpByRef(vault, request, tx, tx.code);
  }
  if (isVaultErrorCode(tx.code)) {
    return {
      kind: "refused",
      txHash: tx.txHash,
      code: tx.code,
      detail: `spend panicked with PROBARION:${tx.code}`,
    };
  }
  if (isOutOfNearCode(tx.code)) return definite(tx, tx.code, tx.failure ?? tx.code);
  return definite(tx, tx.code ?? "TxFailed", `spend failed: ${tx.failure ?? "no detail"}`);
}

/**
 * DuplicateRef or DuplicateInvoice on a ref this cycle sent for the first time (C2 d). The code already
 * refused a used ref and a live invoice, so the spend that holds them is this decision's own (the InvalidNonce
 * re-sign corner: the first copy landed, its answer was lost), another writer's, or not visible yet.
 *
 * - This decision's spend found (same ref, decision_hash, invoice, mandate, amount): its status decides.
 * - Another decision's spend holds the ref (DuplicateRef) or holds the invoice live (DuplicateInvoice): the
 *   contract's refusal.
 * - Nothing holds it in the view read (T13-R1 item 1: an RPC a block behind the one that holds this
 *   decision's own first copy), or the lookup failed: unknown. It may have paid.
 */
async function lookUpByRef(
  vault: VaultClient,
  request: SpendRequest,
  tx: TxOutcome,
  code: DuplicateCode,
): Promise<SpendRead> {
  const unknown = (why: string): SpendRead => ({
    kind: "unknown",
    txHash: tx.txHash,
    spendId: null,
    code,
    contractCode: code,
    why,
  });
  let spends: SpendView[];
  try {
    spends = await vault.listAllSpends();
  } catch (error) {
    return unknown(
      `spend answered PROBARION:${code} and the spend could not be looked up by ref (${messageOf(error)}); it may be this decision's own spend`,
    );
  }
  const own = spends.find(
    (s) =>
      s.ref === request.ref &&
      s.decision_hash === request.decision_hash &&
      s.invoice_hash === request.invoice_hash &&
      s.mandate_id === request.mandate_id &&
      s.amount === request.amount,
  );
  if (own === undefined) {
    const holder =
      code === "DuplicateRef"
        ? spends.find((s) => s.ref === request.ref)
        : spends.find((s) => s.invoice_hash === request.invoice_hash && !RELEASED.has(s.status));
    if (holder !== undefined) {
      const what = code === "DuplicateRef" ? "ref" : "invoice";
      return {
        kind: "refused",
        txHash: tx.txHash,
        code,
        detail: `spend panicked with PROBARION:${code}: spend ${holder.id} of another decision holds the ${what}`,
      };
    }
    return unknown(
      `spend answered PROBARION:${code}, but no spend holds the ${code === "DuplicateRef" ? "ref" : "invoice"} in the view read (the RPC may be behind the block that holds this decision's own first copy); it may have paid`,
    );
  }
  if (isSettled(own.status)) {
    return {
      kind: "ok",
      result: { spend_id: own.id, status: own.status },
      txHash: null,
      byRef: { code, answeredTxHash: tx.txHash },
    };
  }
  if (own.status === "pending") {
    return {
      kind: "unknown",
      txHash: tx.txHash,
      spendId: own.id,
      code: "pending",
      contractCode: code,
      why: `spend ${own.id} of this decision is still pending`,
    };
  }
  return {
    kind: "failed",
    txHash: null,
    entryTxHash: tx.txHash,
    spendId: own.id,
    released: true,
    entryStatus: own.status,
    entryCode: code,
    code: own.status,
    detail: `spend ${own.id} of this decision ended ${own.status}; the vault released the reservation`,
  };
}

/** The payment entry and the outcome for one read of a `spend` answer. */
export interface SpendRecord {
  rules: RuleResult[];
  contract: NonNullable<LedgerEntryBody["contract"]>;
  settlement: LedgerEntryBody["settlement"];
  fields: OutcomeFields;
  warning: string | null;
}

/** Maps a `SpendRead` to its payment entry and outcome (the table in the Task 13 report, section 2.4). */
export function recordSpend(read: SpendRead, payee: Payee | undefined, ref: string): SpendRecord {
  switch (read.kind) {
    case "ok": {
      const { result, byRef } = read;
      // A spend found by ref after a duplicate answer was paid by an earlier transaction whose hash is
      // unknown: the answered (re-signed) transaction is recorded, and the duplicate code goes into a rule.
      const settlement =
        result.status === "burned" && payee?.type === "intents"
          ? {
              chain: payee.chain,
              tx_hash: null,
              burn_tx_hash: byRef === null ? read.txHash : null,
            }
          : null;
      const rules: RuleResult[] =
        byRef === null
          ? []
          : [
              {
                id: "invoice.duplicate",
                outcome: "pass",
                detail: `the contract answered PROBARION:${byRef.code} for a re-signed copy of this spend; spend ${result.spend_id} under this decision holds the ${byRef.code === "DuplicateRef" ? "ref" : "invoice"}: it is this decision's spend`,
              },
            ];
      return {
        rules,
        contract: {
          code: null,
          tx_hash: byRef === null ? read.txHash : byRef.answeredTxHash,
          spend_id: result.spend_id,
          status: result.status,
        },
        settlement,
        fields: {
          status: result.status,
          spendId: result.spend_id,
          code: null,
          txHash: byRef === null ? read.txHash : null,
        },
        warning: null,
      };
    }
    case "unknown":
      return {
        rules: [],
        contract: {
          code: read.contractCode,
          tx_hash: read.txHash,
          spend_id: read.spendId,
          status: "unknown",
        },
        settlement: null,
        fields: {
          status: "unconfirmed",
          spendId: read.spendId,
          code: read.code,
          txHash: read.txHash,
        },
        warning: `spend ${read.txHash ?? "(no tx hash)"} for ref ${ref} has an unknown outcome (${read.why}): it may have paid. Never send it again, least of all under a fresh ref. Until the chain shows the spend, or for 48 hours (the transaction validity window plus a margin, UNKNOWN_SETTLE_MS), this invoice is refused by code; look the spend up by ref to see it sooner.`,
      };
    case "refused":
      return {
        rules: [refusal(read.detail)],
        contract: { code: read.code, tx_hash: read.txHash, spend_id: null, status: "refused" },
        settlement: null,
        fields: {
          status: "refused_by_contract",
          spendId: null,
          code: read.code,
          txHash: read.txHash,
        },
        warning: null,
      };
    case "failed":
      return {
        rules: read.released ? [] : [refusal(read.detail)],
        contract: {
          code: read.entryCode,
          tx_hash: read.entryTxHash,
          spend_id: read.spendId,
          status: read.entryStatus,
        },
        settlement: null,
        fields: { status: "failed", spendId: read.spendId, code: read.code, txHash: read.txHash },
        warning: `spend for ref ${ref} did not pay: ${read.detail}`,
      };
  }
}

/**
 * How long an unconfirmed payment is guarded (T13-R2): after 86,400 blocks the tx expires (<=48 h at <=2 s
 * blocks); even if it lands later, the contract lets at most one spend of the invoice pay. Counted from the
 * payment entry's `at`, which is written after the transaction was signed, so the bound is conservative.
 */
export const UNKNOWN_SETTLE_MS = 48 * 3600 * 1000;

/** True when the entry's `at` is more than `UNKNOWN_SETTLE_MS` before `now`; an unreadable `at` never settles. */
function settledByTime(entry: LedgerEntry, now: Date): boolean {
  const at = Date.parse(entry.body.at);
  return Number.isFinite(at) && now.getTime() - at > UNKNOWN_SETTLE_MS;
}

/**
 * T13-R1 item 6, bounded by T13-R2: an earlier payment of this invoice whose outcome is unknown and not yet
 * settled, or null. A `contract.status: "unknown"` payment entry is settled when any of these hold:
 * - a later payment entry of the same decision records a known status;
 * - a spend on chain carries that decision's hash (then the chain state decides, through `decide()`'s
 *   duplicate rules);
 * - its `at` is more than `UNKNOWN_SETTLE_MS` before `now` (the instance's clock) and no spend on chain
 *   carries the decision's hash: after 86,400 blocks the tx expires (<=48 h at <=2 s blocks); even if it lands
 *   later, the contract lets at most one spend of the invoice pay.
 * The ledger body holds no `ref`, so the match is by invoice hash, which is the double-pay risk (a fresh ref
 * for the same invoice); the contract refuses a reused ref by itself.
 */
export function unresolvedPayment(
  entries: readonly LedgerEntry[],
  invoiceHash: Hex32,
  spends: readonly SpendView[],
  now: Date,
): LedgerEntry | null {
  const onChain = new Set(spends.map((s) => s.decision_hash));
  const known = new Set<string>();
  for (const e of entries) {
    const decision = e.body.refs?.decision_body_hash;
    if (e.body.kind === "payment" && e.body.contract?.status !== "unknown" && decision) {
      known.add(decision);
    }
  }
  for (const e of entries) {
    const decision = e.body.refs?.decision_body_hash;
    if (
      e.body.kind === "payment" &&
      e.body.contract?.status === "unknown" &&
      e.body.invoice_hash === invoiceHash &&
      decision !== undefined &&
      !known.has(decision) &&
      !onChain.has(decision) &&
      !settledByTime(e, now)
    ) {
      return e;
    }
  }
  return null;
}

/**
 * Refuses a decision because of an unconfirmed earlier payment that is not yet settled (`unresolvedPayment`).
 * The RuleId is `ledger.unresolved` (ICR-8): "unknown, wait", distinct from `invoice.duplicate`, which stays
 * "already paid". The passing `invoice.duplicate` rule is kept (the chain holds no live spend of the invoice)
 * and the refusal goes right after it, or at the end when the decision has none (raw mode). The detail says
 * when the invoice can be retried.
 */
export function refuseForUnresolved(decision: Decision, unresolved: LedgerEntry): Decision {
  const at = Date.parse(unresolved.body.at);
  const txHash = unresolved.body.contract?.tx_hash ?? null;
  const tx = txHash === null ? "" : ` (tx ${txHash})`;
  const retry = Number.isFinite(at)
    ? `this invoice can be retried after ${new Date(at + UNKNOWN_SETTLE_MS).toISOString()}`
    : "this invoice can be retried once that outcome is known";
  const rule: RuleResult = {
    id: "ledger.unresolved",
    outcome: "refuse",
    detail: `an unconfirmed payment for this invoice from ${unresolved.body.at}${tx} may still land; ${retry}, and its outcome may appear on chain sooner`,
  };
  const duplicate = decision.rules.findIndex((r) => r.id === "invoice.duplicate");
  const rules = [...decision.rules];
  rules.splice(duplicate === -1 ? rules.length : duplicate + 1, 0, rule);
  return { ...decision, verdict: "refuse", rules };
}
