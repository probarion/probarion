import type { MandateView, Payee, SpendStatus, SpendView, VaultConfig } from "@probarion/core";
import type { InvoiceRow } from "@/lib/payables/store";
import { heldActions, whyUnavailable } from "./display";
import { isVaultConfig, type Read } from "./vaults";

// The approval page an alert links to (roadmap G2): /console/<vault>/approve/<spend>. What it offers is decided here,
// from the chain's answers alone: approve only for a spend the chain reads as held, and approve or reject only to an
// account the chain lists as one of the vault's approvers. The console's own member list is not asked: an approver it
// still lists may have been dropped since, and the vault would refuse them (NotApprover). Nothing here signs: the page
// hands the approver's wallet the transaction, and the vault checks everything again when it runs.

/** A spend id as the contract numbers spends: a whole number from 1, at most 2^53 - 1 (so it stays exact in JSON). */
const SPEND_ID = /^[1-9][0-9]{0,15}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;
const STATUSES: readonly SpendStatus[] = [
  "held",
  "pending",
  "paid",
  "burned",
  "failed",
  "rejected",
  "expired",
];

const isStr = (v: unknown): v is string => typeof v === "string";
const isDigits = (v: unknown): v is string => isStr(v) && DIGITS.test(v);
const isId = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The spend id in the page's path, or null for anything else: it never reaches a chain read or a transaction. */
export function parseSpendId(v: unknown): number | null {
  if (!isStr(v) || !SPEND_ID.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** The mandate id of a `get_spend` answer, to read that mandate next; null when the answer has none. */
export function mandateIdOf(spend: unknown): number | null {
  return isRecord(spend) && isId(spend.mandate_id) ? spend.mandate_id : null;
}

/** The approval page of a spend, as the console links it. */
export function approvePath(vault: string, spendId: number): string {
  return `/console/${encodeURIComponent(vault)}/approve/${spendId}`;
}

function isPayee(v: unknown): v is Payee {
  if (!isRecord(v)) return false;
  if (v.type === "near") return isStr(v.account_id);
  return (
    v.type === "intents" &&
    (v.chain === "base" || v.chain === "solana") &&
    isStr(v.address) &&
    isStr(v.asset)
  );
}

/** `get_spend`'s answer for this id, field by field: the page shows the amount and the payee it hands to a wallet. */
function isSpendOf(v: unknown, spendId: number): v is SpendView {
  return (
    isRecord(v) &&
    v.id === spendId &&
    isId(v.mandate_id) &&
    isDigits(v.amount) &&
    isStr(v.invoice_hash) &&
    isStr(v.ref) &&
    isStr(v.decision_hash) &&
    isStr(v.agent_pk) &&
    isPayee(v.destination) &&
    STATUSES.includes(v.status as SpendStatus) &&
    isDigits(v.created_at_ns) &&
    (v.held_until_ns === null || isDigits(v.held_until_ns)) &&
    (v.memo === null || isStr(v.memo))
  );
}

function isMandateOf(v: unknown, mandateId: number): v is MandateView {
  return (
    isRecord(v) &&
    v.id === mandateId &&
    isPayee(v.payee) &&
    isDigits(v.max_per_payment) &&
    isDigits(v.max_total) &&
    isDigits(v.spent) &&
    isDigits(v.reserved) &&
    isDigits(v.approval_above) &&
    isDigits(v.expires_at_ns) &&
    isCount(v.uses) &&
    isCount(v.max_uses) &&
    isStr(v.label) &&
    isStr(v.status)
  );
}

export type ApproveState =
  /** The config or the spend could not be read, or was not one: nothing is shown or offered. */
  | { kind: "unreadable"; what: "config" | "spend"; why: string }
  /** The vault has no spend with this id. */
  | { kind: "missing" }
  /** The chain reads the spend as anything but held: there is nothing to approve or reject. */
  | {
      kind: "not_held";
      config: VaultConfig;
      spend: SpendView;
      mandate: Read<MandateView | null>;
    }
  | {
      kind: "held";
      config: VaultConfig;
      spend: SpendView;
      mandate: Read<MandateView | null>;
      /** The signed-in account is on the chain's approver list. */
      approver: boolean;
      canApprove: boolean;
      canReject: boolean;
      /** Why approve (or both) is not offered, or null. */
      note: string | null;
      /** The mandate's `approval_above` when the spend's amount is above it: the contract's reason for the hold. */
      aboveThreshold: string | null;
    };

export function approveState(i: {
  /** The session's account: the one whose wallet would sign. */
  account: string;
  spendId: number;
  config: Read<unknown>;
  spend: Read<unknown>;
  /** `get_mandate` for the spend's mandate. */
  mandate: Read<unknown>;
  nowMs: number;
}): ApproveState {
  if (!i.config.ok)
    return { kind: "unreadable", what: "config", why: whyUnavailable(i.config.kind) };
  if (!isVaultConfig(i.config.value)) {
    return { kind: "unreadable", what: "config", why: whyUnavailable("rpc") };
  }
  if (!i.spend.ok) return { kind: "unreadable", what: "spend", why: whyUnavailable(i.spend.kind) };
  if (i.spend.value === null) return { kind: "missing" };
  if (!isSpendOf(i.spend.value, i.spendId)) {
    return { kind: "unreadable", what: "spend", why: whyUnavailable("rpc") };
  }
  const config = i.config.value;
  const spend = i.spend.value;
  const mandate: Read<MandateView | null> = !i.mandate.ok
    ? i.mandate
    : i.mandate.value === null || isMandateOf(i.mandate.value, spend.mandate_id)
      ? { ok: true, value: i.mandate.value }
      : { ok: false, kind: "rpc" };
  if (spend.status !== "held") return { kind: "not_held", config, spend, mandate };

  const aboveThreshold =
    mandate.ok &&
    mandate.value !== null &&
    BigInt(spend.amount) > BigInt(mandate.value.approval_above)
      ? mandate.value.approval_above
      : null;
  const held = { kind: "held" as const, config, spend, mandate, aboveThreshold };
  if (!config.approvers.includes(i.account)) {
    return {
      ...held,
      approver: false,
      canApprove: false,
      canReject: false,
      note: `Only the vault's approvers can approve or reject: ${config.approvers.join(", ")}. You are signed in as ${i.account}.`,
    };
  }
  // The vault's own refusals of approve (held.rs): a frozen vault, a hold that ran out, a revoked mandate. Reject has
  // none of them, so it is offered whenever the spend is held.
  const act = heldActions(spend.held_until_ns, config.frozen, i.nowMs);
  if (!act.canApprove) {
    return { ...held, approver: true, canApprove: false, canReject: true, note: act.note };
  }
  if (!mandate.ok) {
    return {
      ...held,
      approver: true,
      canApprove: false,
      canReject: true,
      note: `The mandate could not be read (${whyUnavailable(mandate.kind)}), so approve is not offered. Reload to try again; reject does not need it.`,
    };
  }
  if (mandate.value === null || mandate.value.status === "revoked") {
    return {
      ...held,
      approver: true,
      canApprove: false,
      canReject: true,
      note: "The mandate is revoked: the vault refuses approve (MandateInactive). Reject gives its reservation back.",
    };
  }
  return { ...held, approver: true, canApprove: true, canReject: true, note: null };
}

/** The console's invoice for a spend: the row with the invoice hash and the ref the chain recorded for it, or null. */
export function matchInvoice(rows: readonly InvoiceRow[], spend: SpendView): InvoiceRow | null {
  return rows.find((r) => r.invoice_hash === spend.invoice_hash && r.ref === spend.ref) ?? null;
}
