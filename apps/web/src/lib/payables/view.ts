import {
  isNearTxHash,
  type LedgerEntry,
  type MandateView,
  type ModelProposal,
  type RuleResult,
} from "@probarion/core";
import type { SpendOutcome } from "@probarion/sdk";
import type { Tone } from "@/components/ui";
import { explorerTxUrl, type Network } from "@/lib/config";
import { safeText } from "@/lib/proof/sanitize";
import type { AmountIssue } from "./amount";
import { DIGITS } from "./forms";
import { OWNER_CONFIRMS_RULE } from "./owner-confirms";
import { payeeId } from "./payee";
import type { InvoiceRow, InvoiceStatus } from "./store";

// How the console shows one Payables cycle (plan 04 Task 14): what the model wanted, what the code allowed, what the
// contract did. Pure: it reads the signed ledger, the SDK outcome and the invoice row, and nothing else.
//
// Every string that came from the invoice text (the model's reasoning, its payee hint, rule details that quote the
// invoice, file names) is attacker-influenced, and the ledger can hold any custom rule id, so each one passes through
// safeText before it reaches a page. A link to the explorer is built only for a well-formed NEAR tx hash.

/** The badge for each attestation state. It claims what the SDK checked when it wrote the entry, and no more. */
export const ATTESTATION_LABEL = {
  attested: "Attested (checks A1–A7 passed)",
  "rules-only": "Rules only (no model)",
  missing: "No attestation",
} as const;

export type AttestationState = keyof typeof ATTESTATION_LABEL;

/** A rule as the console shows it: its id and detail made safe, its outcome one it knows or "unknown". */
export type ShownRule = { id: string; outcome: RuleResult["outcome"] | "unknown"; detail: string };

export interface CycleView {
  /** False when the outcome's decision entry is not in the ledger (the columns then show nothing about it). */
  found: boolean;
  modelWanted: {
    action: string;
    mandateId: number | null;
    amount: string | null;
    payeeHint: string | null;
    reasoning: string;
    confidence: number;
  } | null;
  codeAllowed: {
    verdict: "allow" | "hold" | "refuse" | "unknown" | null;
    decidedBy: "model+rules" | "rules-only" | "unknown" | null;
    rules: ShownRule[];
    firstBlocking: ShownRule | null;
  };
  contractDid: {
    status: SpendOutcome["status"];
    code: string | null;
    spendId: number | null;
    txUrl: string | null;
    label: string;
  };
  attestation: {
    state: AttestationState;
    label: string;
    model: string | null;
    chatId: string | null;
    signingAddress: string | null;
  };
  anchorTxUrl: string | null;
  decisionHash: string;
}

/** Room for the model's reasoning (the SDK caps it at 2,000 characters) and for a rule detail that quotes it. */
const LONG = 2_000;
const SHORT = 120;

/** What one SDK outcome means, in words. `spendId` null on a hold: the code held it and nothing was sent. */
export function outcomeLabel(
  status: SpendOutcome["status"],
  code: string | null | undefined,
  spendId?: number | null,
): string {
  switch (status) {
    case "refused_by_code":
      return "Not sent: code refused it";
    case "refused_by_contract":
      return `Contract refused: ${code ? safeText(code, SHORT) : "unknown code"}`;
    case "held":
      return spendId === null ? "Held by code: nothing was sent" : "Held for approval";
    case "paid":
      return "Paid on NEAR";
    case "burned":
      return "Withdrawn from NEAR to Base or Solana (release pending)";
    case "settled":
      return "Settled on Base or Solana";
    case "failed":
      return "Not paid (failed); any reservation was released";
    case "unconfirmed":
      return "Payment sent, confirmation pending: do not resend";
    default:
      return `Unknown outcome (${safeText(status, 40)}): check the vault before you act`;
  }
}

/** What an invoice row's status means. `owner` false words a waiting invoice for an approver or viewer. */
export function invoiceStatusLabel(status: InvoiceStatus, owner = true): string {
  switch (status) {
    case "received":
      return "Received";
    case "processing":
      return "Outcome unknown: do not resend";
    case "decided":
      return "Decided";
    case "unconfirmed":
      return "Payment sent, confirmation pending: do not resend";
    case "awaiting_owner":
      return `Waiting for ${owner ? "you" : "the owner"}: no attested model confirmed the amount`;
    case "error":
      return "Stopped before any payment: upload it again to retry";
    case "rejected":
      return "Rejected by the owner: nothing was paid";
    default:
      return `Unknown status (${safeText(status, 40)})`;
  }
}

/** What an invoice row came to, in words, with the tone of its badge: the SDK outcome once decided, else the status. */
export function rowResult(row: InvoiceRow, owner = true): { label: string; tone: Tone } {
  if (row.status === "decided" && row.outcome) {
    const s = row.outcome.status;
    return {
      label: outcomeLabel(s, row.outcome.code, row.outcome.spendId),
      tone:
        s === "paid" || s === "settled" || s === "burned" ? "good" : s === "held" ? "warn" : "bad",
    };
  }
  const tone: Tone =
    row.status === "error"
      ? "bad"
      : row.status === "rejected" || row.status === "received"
        ? "neutral"
        : "warn";
  return { label: invoiceStatusLabel(row.status, owner), tone };
}

const BY_HAND =
  "Nothing was sent. If the invoice is right, you can pay it by hand from the vault (the Overview tab withdraws to your wallet).";

/** Why the code read the amount as "0" (rule invoice.amount_invalid then refused it), in one plain sentence. */
export function amountIssueText(issue: AmountIssue): string {
  switch (issue) {
    case "not_found":
      return `The code found no final total in the invoice. ${BY_HAND}`;
    case "ambiguous":
      return `The invoice states more than one total, or totals that disagree. ${BY_HAND}`;
    case "unreadable":
      return `The code could not read the total exactly (its layout, a note beside it, or characters it does not accept). ${BY_HAND}`;
    case "currency":
      return `The total is not in USD or USDC. ${BY_HAND}`;
    case "truncated":
      return `The invoice was cut short (too many pages or characters), so its final total may be missing. ${BY_HAND}`;
    case "zero":
      return `The total is zero. ${BY_HAND}`;
    case "not_payable":
      return `The document does not read as an invoice to pay (not titled an invoice, or marked paid, void, a quote, receipt or statement). ${BY_HAND}`;
    default:
      return `The code could not read the amount. ${BY_HAND}`;
  }
}

/** Base units of USDC with all six decimals ("20000000" -> "20.000000"), or "unreadable". */
export function usdcFixed(units: string): string {
  if (typeof units !== "string" || !DIGITS.test(units)) return "unreadable";
  const v = BigInt(units);
  return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`;
}

function hintText(h: ModelProposal["payee_hint"]): string | null {
  if (!h || typeof h !== "object") return null;
  if (h.near_account) return safeText(h.near_account, SHORT);
  if (h.address) return safeText(`${h.chain ?? "evm"}:${h.address}`, SHORT);
  return h.name ? safeText(h.name, SHORT) : null;
}

/** A value the ledger holds as one of `known`, or "unknown": any other value is not shown as it came. */
function knownOr<T extends string>(value: unknown, known: readonly T[]): T | "unknown" {
  return known.includes(value as T) ? (value as T) : "unknown";
}
const RULE_OUTCOMES = ["pass", "hold", "refuse"] as const;
const VERDICTS = ["allow", "hold", "refuse"] as const;
const DECIDERS = ["model+rules", "rules-only"] as const;

const shownRule = (r: RuleResult): ShownRule => ({
  id: safeText(r.id, SHORT),
  outcome: knownOr(r.outcome, RULE_OUTCOMES),
  detail: safeText(r.detail, LONG),
});

const nullableText = (v: unknown, max = SHORT): string | null =>
  v === null || v === undefined ? null : safeText(v, max);

/** The explorer link of a transaction, only for a well-formed NEAR tx hash. */
function txUrl(network: Network, hash: string | null | undefined): string | null {
  return hash && isNearTxHash(hash) ? explorerTxUrl(network, hash) : null;
}

/** The decision entry an outcome names (by its body hash), or null. */
export function decisionOf(
  entries: readonly LedgerEntry[],
  outcome: SpendOutcome,
): LedgerEntry | null {
  return (
    entries.find((e) => e.body_hash === outcome.decisionHash && e.body.kind === "decision") ?? null
  );
}

/**
 * The three columns of one cycle. `anchorTxHash` is the invoice row's `anchor_tx_hash` (R20): no ledger entry holds
 * the hash of the transaction that anchors it, so a ledger `anchor` entry is never read here.
 */
export function buildCycleView(
  entries: readonly LedgerEntry[],
  outcome: SpendOutcome,
  network: Network,
  anchorTxHash: string | null = null,
): CycleView {
  const decision = decisionOf(entries, outcome);
  const body = decision?.body ?? null;
  const p = body?.proposal ?? null;
  const rules = (body?.rules ?? []).map(shownRule);
  const ev = body?.evidence ?? null;
  const state: AttestationState = ev
    ? "attested"
    : body?.decided_by === "rules-only"
      ? "rules-only"
      : "missing";
  return {
    found: decision !== null,
    modelWanted: p
      ? {
          action: safeText(p.action, SHORT),
          mandateId: typeof p.mandate_id === "number" ? p.mandate_id : null,
          amount: typeof p.amount === "string" ? safeText(p.amount, SHORT) : null,
          payeeHint: hintText(p.payee_hint),
          reasoning: safeText(p.reasoning ?? "", LONG),
          confidence: Number.isFinite(p.confidence) ? p.confidence : 0,
        }
      : null,
    codeAllowed: {
      verdict: body?.verdict == null ? null : knownOr(body.verdict, VERDICTS),
      decidedBy: body?.decided_by == null ? null : knownOr(body.decided_by, DECIDERS),
      rules,
      firstBlocking: rules.find((r) => r.outcome !== "pass") ?? null,
    },
    contractDid: {
      status: outcome.status,
      code: nullableText(outcome.code),
      spendId: outcome.spendId,
      txUrl: txUrl(network, outcome.txHash),
      label: outcomeLabel(outcome.status, outcome.code, outcome.spendId),
    },
    attestation: {
      state,
      label: ATTESTATION_LABEL[state],
      model: ev ? nullableText(ev.model) : null,
      chatId: ev ? nullableText(ev.chat_id) : null,
      signingAddress: ev ? nullableText(ev.signature?.signing_address) : null,
    },
    anchorTxUrl: txUrl(network, anchorTxHash),
    decisionHash: safeText(outcome.decisionHash, 64),
  };
}

/**
 * Why an invoice waits for the owner: the owner rule's own detail, and each rule before it that held or refused (an
 * Intents balance that is too low, a model with low confidence).
 */
export function waitReasons(
  entries: readonly LedgerEntry[],
  outcome: SpendOutcome,
): { owner: ShownRule | null; before: ShownRule[] } {
  const rules = decisionOf(entries, outcome)?.body.rules ?? [];
  const at = rules.findIndex((r) => r.id === OWNER_CONFIRMS_RULE);
  const before = (at < 0 ? rules : rules.slice(0, at)).filter((r) => r.outcome !== "pass");
  return {
    owner: at < 0 ? null : shownRule(rules[at] as RuleResult),
    before: before.map(shownRule),
  };
}

/** The latest decision entry the ledger holds for an invoice hash (the highest seq), or null. */
function latestDecision(entries: readonly LedgerEntry[], invoiceHash: string): LedgerEntry | null {
  let best: LedgerEntry | null = null;
  for (const e of entries) {
    if (e.body.kind !== "decision" || e.body.invoice_hash !== invoiceHash) continue;
    if (best === null || e.body.seq > best.body.seq) best = e;
  }
  return best;
}

/** How close another invoice's amount is to the one waiting: the same, within 5%, or neither. */
export type AmountMatch = "equal" | "near" | null;

export interface PayeeRow {
  id: string;
  ref: string;
  status: InvoiceStatus;
  label: string;
  /** USDC base units, or null when no amount is known (no decision yet). */
  amount: string | null;
  match: AmountMatch;
  createdBy: string;
  createdAt: string;
}

/** The window of "recent" invoices of a payee shown before Confirm (ruling W-T14-R1 item 6). */
export const PAYEE_WINDOW_DAYS = 90;

/** An invoice's payee (payeeId form): its mandate, the row's or else its latest decision's, read from the chain. */
export function payeeOf(
  row: InvoiceRow,
  entries: readonly LedgerEntry[],
  mandates: readonly MandateView[],
): string | null {
  return payeeAndAmount(row, entries, mandates).payee;
}

/** An invoice's payee and amount: its mandate (the row's, else its latest decision's, read from the chain) and amount. */
function payeeAndAmount(
  row: InvoiceRow,
  entries: readonly LedgerEntry[],
  mandates: readonly MandateView[],
): { payee: string | null; amount: string | null } {
  const d = latestDecision(entries, row.invoice_hash);
  const mandateId = row.mandate_id ?? d?.body.mandate_id ?? null;
  const m = mandateId === null ? undefined : mandates.find((x) => x.id === mandateId);
  const amount = row.suggested_amount ?? d?.body.amount ?? null;
  return {
    payee: m ? payeeId(m.payee) : null,
    amount: amount !== null && DIGITS.test(amount) ? amount : null,
  };
}

/** Equal, within 5% of `target` (|a - t| * 100 <= t * 5), or neither. */
export function amountMatch(amount: string | null, target: string | null): AmountMatch {
  if (amount === null || target === null || !DIGITS.test(amount) || !DIGITS.test(target))
    return null;
  if (amount === target) return "equal";
  const a = BigInt(amount);
  const t = BigInt(target);
  const gap = a > t ? a - t : t - a;
  return gap * 100n <= t * 5n ? "near" : null;
}

/**
 * Every other invoice of the same payee uploaded in the last 90 days, newest first, whatever its amount, with its
 * status, its uploader and whether its amount equals the waiting one or is within 5% of it (ruling W-T14-R1 item 6:
 * an amount moved by a cent must not hide a second invoice). This is shown, never collapsed, before the owner
 * confirms: a re-render of an invoice with other text and no readable number is keyed as a new invoice by the
 * duplicate guard, and this list is where the owner sees it. An invoice with no mandate and no decision yet has no
 * payee to compare.
 */
export function recentPayeeRows(
  target: InvoiceRow,
  rows: readonly InvoiceRow[],
  entries: readonly LedgerEntry[],
  mandates: readonly MandateView[],
  now: Date,
  owner = true,
): { payee: string | null; amount: string | null; rows: PayeeRow[] } {
  const mine = payeeAndAmount(target, entries, mandates);
  if (mine.payee === null) return { ...mine, rows: [] };
  const since = now.getTime() - PAYEE_WINDOW_DAYS * 86_400_000;
  const same = rows
    .filter((r) => r.id !== target.id)
    .filter((r) => {
      const t = Date.parse(r.created_at);
      return Number.isNaN(t) || t >= since;
    })
    .flatMap((r) => {
      const theirs = payeeAndAmount(r, entries, mandates);
      if (theirs.payee !== mine.payee) return [];
      return [
        {
          id: r.id,
          ref: safeText(r.ref, 64),
          status: r.status,
          label:
            r.status === "decided" && r.outcome
              ? outcomeLabel(r.outcome.status, r.outcome.code, r.outcome.spendId)
              : invoiceStatusLabel(r.status, owner),
          amount: theirs.amount,
          match: amountMatch(theirs.amount, mine.amount),
          createdBy: safeText(r.created_by, 64),
          createdAt: r.created_at,
        },
      ];
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return { ...mine, rows: same };
}
