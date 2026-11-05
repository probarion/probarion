import "server-only";
import type { InvoiceFacts, LedgerEntry, MandateView, ModelProposal } from "@probarion/core";
import {
  hashInvoice,
  ProbarionError,
  type SpendOutcome,
  type SpendOutcomeStatus,
} from "@probarion/sdk";
import type { Db } from "@/lib/db/port";
import { withLease } from "@/lib/db/tenants";
import type { CanaryMode } from "@/lib/env";
import { log, scrubText } from "@/lib/log";
import { extractFacts } from "@/lib/payables/facts";
import { spendableNow } from "@/lib/payables/mandate";
import { CANARY_LIMITS, claimRawSlot, estimateTokens, type RawSkip, tokensToday } from "./limits";
import { classify, type Technique } from "./technique";

// The Canary's cycle (spec §14.3, plan 04 Task 17). A visitor's text goes to a deliberately gullible model, then
// through the SDK's `process` exactly as Payables' invoices do: code rules and the vault contract decide. In `live`
// mode a proposal to pay that the CODE refused is also sent to the contract unfiltered ("raw mode", rate-limited), to
// show the contract refuses it too. Each attempt is stored as hashes and labels, never as the visitor's text.

/** What the cycle needs from the SDK's `Probarion` (and what tests fake). */
export interface CanaryProbarion {
  process(i: { text: string; facts: InvoiceFacts; ref: string }): Promise<SpendOutcome>;
  requestSpend(i: {
    mandateId: number;
    amount: string;
    invoiceHash: string;
    ref: string;
    proposal?: ModelProposal | null;
    skipPreflight?: boolean; // SDK v2: always send spend; Canary raw mode only
  }): Promise<SpendOutcome>;
}

export interface CanaryDeps {
  db: Db;
  mode: CanaryMode;
  now(): Date;
  tenant: { tenant_id: string; vault_id: string };
  /** Every mandate of the Canary vault, as the chain shows it now. Throws when the chain cannot be read. */
  mandates(): Promise<MandateView[]>;
  /**
   * The Probarion for `mandate`: signing with the agent key that mandate is bound to and the tenant's ledger key.
   * Null when either key is not usable here (no active key, cannot be opened): never another key, never a retry.
   */
  makeProbarion(o: { mandate: MandateView; requestId: string }): Promise<CanaryProbarion | null>;
  /** The access-key allowance of `mandate`'s agent key in yoctoNEAR; null = unlimited; 0n = the key is not there. */
  agentAllowance(mandate: MandateView): Promise<bigint | null>;
  ledgerByHash(bodyHash: string): Promise<LedgerEntry | null>;
}

export interface AttemptInput {
  text: string;
  visitorHash: string;
  ipHash: string;
  isTeam: boolean;
  requestId: string;
}

export type AttemptResult =
  | {
      status: "rejected";
      /** "failed": the cycle stopped before any spend was sent (the attempt is stored as an error). */
      reason: "closed" | "too_long" | "empty" | "budget" | "busy" | "not_ready" | "failed";
    }
  | {
      status: "done";
      /** Null when the attempt could not be stored (logged); the outcome below still stands. */
      attemptId: string | null;
      techniques: Technique[];
      proposal: {
        action: ModelProposal["action"];
        mandateId: number | null;
        amount: string | null;
        reasoning: string;
      } | null;
      code: { status: SpendOutcomeStatus; rule: string | null; txHash: string | null };
      raw:
        | { sent: false; skipped: RawSkip }
        | { sent: true; status: SpendOutcomeStatus; code: string | null; txHash: string | null };
    };

type Done = Extract<AttemptResult, { status: "done" }>;

/** The statuses canary_attempts.code_status accepts for a cycle's outcome. */
const CODE_STATUSES: ReadonlySet<string> = new Set([
  "refused_by_code",
  "refused_by_contract",
  "held",
  "paid",
  "burned",
  "settled",
  "failed",
  "unconfirmed",
]);

/**
 * The status stored for an SDK outcome. A status this code does not know may have paid, so it is stored as
 * `unconfirmed` (as Payables does) and the table's CHECK never turns a recorded cycle into a lost one.
 */
const codeStatusOf = (status: string): string =>
  CODE_STATUSES.has(status) ? status : "unconfirmed";

/** A short machine label for a column the public feed shows; anything else becomes underscores and is cut. */
function label(value: string | null): string | null {
  if (value === null) return null;
  const clean = value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
  return clean === "" ? null : clean;
}

const U128_MAX = (1n << 128n) - 1n;
const isU128 = (s: string): boolean => /^[1-9][0-9]{0,38}$/.test(s) && BigInt(s) <= U128_MAX;

const messageOf = (e: unknown): string =>
  scrubText(e instanceof Error ? e.message : String(e)).slice(0, 500) || "unknown error";

/**
 * The Canary vault's mandate: the lowest-id one that can still be spent, else the lowest-id one (the cycle then
 * refuses with the precise reason). The vault is meant to hold exactly one. Null when it holds none.
 */
export function canaryMandate(mandates: readonly MandateView[], now: Date): MandateView | null {
  const sorted = [...mandates].sort((a, b) => a.id - b.id);
  return sorted.find((m) => spendableNow(m, now)) ?? sorted[0] ?? null;
}

/** The first rule that stopped the decision: a refusal, else a hold. */
function stoppingRule(entry: LedgerEntry | null): string | null {
  const rules = entry?.body.rules ?? [];
  return (
    (rules.find((r) => r.outcome === "refuse") ?? rules.find((r) => r.outcome === "hold"))?.id ??
    null
  );
}

interface Gate {
  mandate: MandateView;
  outcome: SpendOutcome;
  proposal: ModelProposal | null;
}

/** Why the model's proposal is NOT sent to the contract, or null when it goes. */
async function rawSkip(deps: CanaryDeps, input: AttemptInput, g: Gate): Promise<RawSkip | null> {
  if (deps.mode !== "live") return "mode";
  if (g.outcome.status !== "refused_by_code") return "not_refused_by_code";
  if (g.proposal?.action !== "pay") return "not_pay";
  // An unreadable allowance turns raw mode off: it must never be what lets a spend out.
  let allowance: bigint | null;
  try {
    allowance = await deps.agentAllowance(g.mandate);
  } catch (e) {
    log.warn("canary.allowance_unreadable", { request_id: input.requestId, error: messageOf(e) });
    return "allowance_low";
  }
  if (allowance !== null && allowance < CANARY_LIMITS.minAllowanceYocto) return "allowance_low";
  return claimRawSlot(deps.db, { ipHash: input.ipHash, visitorHash: input.visitorHash });
}

export async function runAttempt(deps: CanaryDeps, input: AttemptInput): Promise<AttemptResult> {
  const mode = deps.mode;
  if (mode === "off" || mode === "replay") return { status: "rejected", reason: "closed" };
  const text = input.text.trim();
  if (text === "") return { status: "rejected", reason: "empty" };
  if (input.text.length > CANARY_LIMITS.maxTextChars) {
    return { status: "rejected", reason: "too_long" };
  }
  const est = estimateTokens(text);
  if ((await tokensToday(deps.db, deps.now())) + est > CANARY_LIMITS.dailyTokenBudget) {
    return { status: "rejected", reason: "budget" };
  }

  const at = { request_id: input.requestId, tenant: deps.tenant.tenant_id };
  let mandate: MandateView | null;
  try {
    mandate = canaryMandate(await deps.mandates(), deps.now());
  } catch (e) {
    log.warn("canary.chain_unavailable", { ...at, error: messageOf(e) });
    return { status: "rejected", reason: "not_ready" };
  }
  if (mandate === null) {
    log.error("canary.no_mandate", at);
    return { status: "rejected", reason: "not_ready" };
  }
  const pb = await deps.makeProbarion({ mandate, requestId: input.requestId });
  if (pb === null) return { status: "rejected", reason: "not_ready" };
  const chosen = mandate;

  const leased = await withLease(
    deps.db,
    deps.tenant.tenant_id,
    "process",
    CANARY_LIMITS.leaseSeconds,
    async (): Promise<AttemptResult> => {
      const invoiceHash = hashInvoice(text);
      const ref = `canary-${invoiceHash.slice(0, 20)}-${deps.now().getTime().toString(36)}`;
      // Only the five InvoiceFacts keys reach the SDK. The purpose is the Canary mandate's own (there is no purpose
      // document to upload), so the rules reach the payee check and the caps instead of stopping at invoice.po_mismatch.
      const read = extractFacts(text, invoiceHash, chosen.purpose_hash);
      const facts: InvoiceFacts = {
        invoice_hash: read.invoice_hash,
        amount: read.amount,
        po_ref: read.po_ref,
        purpose_hash: read.purpose_hash,
        payee_hint: read.payee_hint,
      };
      const techniques = classify(text);
      const stored = {
        visitor_hash: input.visitorHash,
        ip_hash: input.ipHash,
        is_team: input.isTeam,
        mode,
        text_sha256: invoiceHash,
        text_length: text.length,
        techniques,
        request_id: input.requestId,
        est_tokens: est,
      };
      /** Stores the attempt. A failed write is logged with what happened and never hides the outcome. */
      const record = async (fields: Record<string, unknown>): Promise<string | null> => {
        try {
          const { id } = await deps.db.rpc<{ id: string }>("canary_attempt_insert", {
            ...stored,
            ...fields,
          });
          return id;
        } catch (e) {
          log.error("canary.attempt_not_recorded", {
            ...at,
            error: messageOf(e),
            code_status: fields.code_status,
            contract_status: fields.contract_status,
            contract_code: fields.contract_code,
            tx: fields.tx_hash,
          });
          return null;
        }
      };

      let outcome: SpendOutcome;
      try {
        outcome = await pb.process({ text, facts, ref });
      } catch (e) {
        // The SDK sends a spend only after a decision and never throws once it has: nothing went out. The model may have
        // answered, so the attempt is stored (its estimate counts against the day's budget).
        log.error("canary.failed", { ...at, mandate_id: chosen.id, error: messageOf(e) });
        await record({ code_status: "error", raw: false, raw_skipped_reason: "error" });
        return { status: "rejected", reason: "failed" };
      }

      let decision: LedgerEntry | null = null;
      try {
        decision = await deps.ledgerByHash(outcome.decisionHash);
      } catch (e) {
        log.warn("canary.decision_unreadable", { ...at, error: messageOf(e) });
      }
      const proposal = decision?.body.proposal ?? null;
      const rule = stoppingRule(decision);

      const skipped = await rawSkip(deps, input, { mandate: chosen, outcome, proposal });
      let rawOutcome: SpendOutcome | null = null;
      let raw: Done["raw"];
      let threw: { code: string; txHash: string | null } | null = null;
      if (skipped === null && proposal !== null) {
        // Raw mode (spec §14.3): bypass the code rules on purpose and let the contract judge the model's own proposal.
        // The spend is sent ONCE. Whatever comes back, or is thrown, is recorded and never retried: a throw may come after
        // the transaction reached the chain.
        const mandateId = proposal.mandate_id ?? chosen.id;
        const amount =
          proposal.amount !== null && isU128(proposal.amount)
            ? proposal.amount
            : facts.amount !== "0"
              ? facts.amount
              : "1000000";
        try {
          // No `evidence`: process() attested the proposal at the ledger position it wrote its decision after, so it can
          // never verify at this spend's position, and an amount or mandate that differs from the one the model was shown
          // makes the SDK throw before it writes anything.
          rawOutcome = await pb.requestSpend({
            mandateId,
            amount,
            invoiceHash,
            ref: `${ref}:raw`,
            proposal,
            skipPreflight: true,
          });
          raw = {
            sent: true,
            status: rawOutcome.status,
            code: label(rawOutcome.code),
            txHash: rawOutcome.txHash,
          };
        } catch (e) {
          const txHash =
            typeof (e as { txHash?: unknown } | null)?.txHash === "string"
              ? (e as { txHash: string }).txHash
              : null;
          threw = {
            code: label(e instanceof ProbarionError ? e.code : "error") ?? "error",
            txHash,
          };
          log.error("canary.raw_threw", {
            ...at,
            mandate_id: mandateId,
            tx: txHash,
            code: threw.code,
            error: messageOf(e),
          });
          raw = { sent: true, status: "unconfirmed", code: threw.code, txHash };
        }
      } else {
        raw = { sent: false, skipped: skipped ?? "not_pay" };
      }

      const usage = outcome.modelUsage ?? null;
      const attemptId = await record({
        proposal_action: proposal?.action ?? null,
        proposal_mandate_id: proposal?.mandate_id ?? null,
        proposal_amount: proposal?.amount ?? null,
        code_status: codeStatusOf(outcome.status),
        code_rule: label(rule),
        raw: raw.sent,
        raw_skipped_reason: raw.sent ? null : raw.skipped,
        contract_status: threw ? "unconfirmed" : label(rawOutcome?.status ?? null),
        contract_code: threw ? threw.code : label(rawOutcome?.code ?? null),
        tx_hash: (threw ? threw.txHash : rawOutcome?.txHash) ?? outcome.txHash,
        spend_id: rawOutcome?.spendId ?? outcome.spendId,
        decision_hash: outcome.decisionHash,
        raw_decision_hash: rawOutcome?.decisionHash ?? null,
        model_prompt_tokens: usage?.promptTokens ?? null,
        model_completion_tokens: usage?.completionTokens ?? null,
      });
      log.info("canary.attempt", {
        ...at,
        code: outcome.status,
        raw: raw.sent,
        contract_code: raw.sent ? raw.code : null,
      });
      return {
        status: "done",
        attemptId,
        techniques,
        proposal: proposal
          ? {
              action: proposal.action,
              mandateId: proposal.mandate_id,
              amount: proposal.amount,
              reasoning: proposal.reasoning,
            }
          : null,
        code: { status: outcome.status, rule, txHash: outcome.txHash },
        raw,
      };
    },
  );
  return leased.acquired ? leased.value : { status: "rejected", reason: "busy" };
}
