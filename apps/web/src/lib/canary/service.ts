import "server-only";
import { randomBytes } from "node:crypto";
import type { InvoiceFacts, LedgerEntry, MandateView, ModelProposal } from "@probarion/core";
import {
  hashInvoice,
  ProbarionError,
  type SpendOutcome,
  type SpendOutcomeStatus,
} from "@probarion/sdk";
import type { Network } from "@/lib/config";
import type { Db } from "@/lib/db/port";
import { withLease } from "@/lib/db/tenants";
import type { CanaryMode } from "@/lib/env";
import { log, scrubText } from "@/lib/log";
import { extractFacts } from "@/lib/payables/facts";
import { spendableNow } from "@/lib/payables/mandate";
import {
  CANARY_LIMITS,
  claimRawSlot,
  estimateTokens,
  type RawSkip,
  secondsUntilUtcMidnight,
  takeAttemptSlot,
  tokensToday,
} from "./limits";
import { classify, type Technique } from "./technique";
import type { CanaryVia } from "./via";

// The Canary's cycle (spec §14.3, plan 04 Task 17). A visitor's text goes to a deliberately gullible model, then
// through the SDK's `process` exactly as Payables' invoices do: code rules and the vault contract decide, and the
// Canary never pays from its own cycle (rules.ts). In `live` mode a proposal to pay that the CODE refused is also sent to
// the contract unfiltered ("raw mode", rate-limited) to show the contract refuses it too, but ONLY when the contract's
// free dry run says it would refuse: a raw spend the contract would accept is never sent. Each attempt is stored as hashes
// and labels, never as the visitor's text. Its row is opened BEFORE the cycle runs (so a run the platform kills still
// counts against the day's token budget) and says what is happening at each step: `running`, then the code's outcome, then
// "a raw spend is on its way", then the end. The whole attempt has one deadline (CANARY_LIMITS.attemptBudgetMs), counted
// from the route's start, and every phase shares it.

/** What the cycle needs from the SDK's `Probarion` (and what tests fake). */
export interface CanaryProbarion {
  process(i: { text: string; facts: InvoiceFacts; ref: string }): Promise<SpendOutcome>;
  /** The contract's free dry run of `spend`: no gas, no ledger entry. `ok` means the contract would accept it. */
  checkSpend(i: {
    mandateId: number;
    amount: string;
    invoiceHash: string;
    ref: string;
  }): Promise<{ ok: boolean; code: string | null; would_hold: boolean }>;
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
  /** The Canary vault's tenant. Its network is the one every attempt is recorded under (the usage numbers count by it). */
  tenant: { tenant_id: string; vault_id: string; network: Network };
  /** Every mandate of the Canary vault, as the chain shows it now. Throws when the chain cannot be read. */
  mandates(): Promise<MandateView[]>;
  /**
   * The Probarion for `mandate`: signing with the agent key that mandate is bound to and the tenant's ledger key.
   * `remainingMs` is the time the attempt has left: the instance gives it to its chain client, its senders and its model
   * calls. Null when either key is not usable here (no active key, cannot be opened): never another key, never a retry.
   */
  makeProbarion(o: {
    mandate: MandateView;
    requestId: string;
    remainingMs: () => number;
  }): Promise<CanaryProbarion | null>;
  /** The access-key allowance of `mandate`'s agent key in yoctoNEAR; null = unlimited; 0n = the key is not there. */
  agentAllowance(mandate: MandateView): Promise<bigint | null>;
  /** The same for the tenant's LEDGER key (it pays for the anchor of every attempt). Throws when unreadable. */
  ledgerAllowance(): Promise<bigint | null>;
  /** How many entries the tenant's ledger holds now (a cheap, indexed count). */
  ledgerSize(): Promise<number>;
  ledgerByHash(bodyHash: string): Promise<LedgerEntry | null>;
}

export interface AttemptInput {
  text: string;
  visitorHash: string;
  ipHash: string;
  isTeam: boolean;
  requestId: string;
  /** When the route started (epoch ms): the attempt's deadline counts from here. Default: now. */
  startedAt?: number;
  /** The source the visitor's link named (lib/canary/via.ts), already checked. Default: none. */
  via?: CanaryVia | null;
}

export type AttemptResult =
  | {
      status: "rejected";
      /**
       * "failed": the cycle stopped before any spend was sent, or ran out of time (the attempt is stored as an error).
       * "closed": the Canary is off, or its ledger is full. "not_ready": its mandate, keys or ledger key are not usable,
       * or the chain did not answer in time.
       */
      reason: "closed" | "too_long" | "empty" | "budget" | "busy" | "not_ready" | "failed";
      /** For "budget": the seconds until the limit that was hit is over (the route answers Retry-After). */
      retryAfterS?: number;
    }
  | {
      status: "done";
      attemptId: string;
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
type Raw = Done["raw"];

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

// ---- the attempt's deadline ---------------------------------------------------------------------------------------

/** The attempt's time ran out while `what` was still going. */
class DeadlineError extends Error {
  constructor(what: string) {
    super(`${what}: the attempt's time ran out`);
    this.name = "DeadlineError";
  }
}

/** Whether the attempt has given up on work that is still running (see `bounded`): the lease is then not released. */
interface Abandoned {
  gaveUp: boolean;
}

/**
 * Runs `work` unless the time is already out, and gives up on it at the deadline. This is the backstop that makes the
 * attempt's total time a promise: the SDK's own steps are also bounded by the time left (they are given the same clock),
 * but a step this code cannot reach into would otherwise hold the whole attempt. Work that is given up on may still
 * finish in the background; the Canary's cycle never pays (rules.ts), so what it could still do is write ledger entries.
 * That is why `abandoned` (when given) is marked the moment the timer gives up on running work: the cycle then does not
 * release the tenant's lease, which runs out by itself, so no other cycle starts beside it.
 */
function bounded<T>(
  work: () => Promise<T>,
  left: () => number,
  what: string,
  abandoned?: Abandoned,
): Promise<T> {
  const ms = left();
  if (!(ms > 0)) return Promise.reject(new DeadlineError(what));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (abandoned) abandoned.gaveUp = true;
      reject(new DeadlineError(what));
    }, ms);
    work().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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

// ---- before the cycle: can this request run at all? -------------------------------------------------------------

interface Ready {
  text: string;
  est: number;
  mandate: MandateView;
  pb: CanaryProbarion;
}

const rejected = (
  reason: Extract<AttemptResult, { status: "rejected" }>["reason"],
  retryAfterS?: number,
): AttemptResult =>
  retryAfterS === undefined
    ? { status: "rejected", reason }
    : { status: "rejected", reason, retryAfterS };

/**
 * Everything that must hold before a model is called or a slot is taken, cheapest first: the kill switches, the size of
 * the text, the day's token budget, the size of the ledger, the Canary's mandate, the ledger key's allowance, and last
 * (it opens sealed keys) its keys. The two chain reads are held to the attempt's time. Nothing here is stored or counted.
 */
async function admit(
  deps: CanaryDeps,
  input: AttemptInput,
  left: () => number,
): Promise<AttemptResult | Ready> {
  if (deps.mode === "off" || deps.mode === "replay") return rejected("closed");
  const text = input.text.trim();
  if (text === "") return rejected("empty");
  if (input.text.length > CANARY_LIMITS.maxTextChars) return rejected("too_long");
  const est = estimateTokens(text);
  if ((await tokensToday(deps.db, deps.now())) + est > CANARY_LIMITS.dailyTokenBudget) {
    return rejected("budget", secondsUntilUtcMidnight(deps.now()));
  }
  const at = { request_id: input.requestId, tenant: deps.tenant.tenant_id };
  if ((await deps.ledgerSize()) >= CANARY_LIMITS.maxLedgerEntries) {
    log.warn("canary.ledger_full", at);
    return rejected("closed");
  }
  let mandate: MandateView | null;
  try {
    mandate = canaryMandate(
      await bounded(() => deps.mandates(), left, "reading the mandates"),
      deps.now(),
    );
  } catch (e) {
    log.warn("canary.chain_unavailable", { ...at, error: messageOf(e) });
    return rejected("not_ready");
  }
  if (mandate === null) {
    log.error("canary.no_mandate", at);
    return rejected("not_ready");
  }
  // The ledger key anchors every attempt. Below the floor (or unreadable, or gone) the Canary does not run, so its
  // anchors never go stale in silence.
  let ledgerAllowance: bigint | null;
  try {
    ledgerAllowance = await bounded(() => deps.ledgerAllowance(), left, "reading the ledger key");
  } catch (e) {
    log.warn("canary.ledger_allowance_unreadable", { ...at, error: messageOf(e) });
    return rejected("not_ready");
  }
  if (ledgerAllowance !== null && ledgerAllowance < CANARY_LIMITS.minLedgerAllowanceYocto) {
    log.error("canary.ledger_allowance_low", at);
    return rejected("not_ready");
  }
  const pb = await deps.makeProbarion({ mandate, requestId: input.requestId, remainingMs: left });
  if (pb === null) return rejected("not_ready");
  return { text, est, mandate, pb };
}

// ---- raw mode ---------------------------------------------------------------------------------------------------

/** What one raw step decided, and the columns that say so. */
interface RawStep {
  raw: Raw;
  fields: RawFields;
}

interface RawFields {
  raw: boolean;
  raw_skipped_reason: RawSkip | null;
  raw_detail: string | null;
  contract_status: string | null;
  contract_code: string | null;
  tx_hash: string | null;
  spend_id: number | null;
  raw_decision_hash: string | null;
}

/** What the row says before any raw step has run: nothing sent, no reason given yet. */
const RAW_PENDING: RawFields = {
  raw: false,
  raw_skipped_reason: null,
  raw_detail: null,
  contract_status: null,
  contract_code: null,
  tx_hash: null,
  spend_id: null,
  raw_decision_hash: null,
};

const skip = (skipped: RawSkip, detail: string | null = null): RawStep => ({
  raw: { sent: false, skipped },
  fields: { ...RAW_PENDING, raw_skipped_reason: skipped, raw_detail: detail },
});

/** Errors from `requestSpend` that certainly came before any transaction was sent. Anything else may have been sent. */
const PRE_CHAIN_CODES: ReadonlySet<string> = new Set([
  "InvalidInput",
  "ConfigError",
  "LedgerError",
  "RpcError",
]);

interface RawContext {
  deps: CanaryDeps;
  input: AttemptInput;
  pb: CanaryProbarion;
  mandate: MandateView;
  outcome: SpendOutcome;
  /** The decision the code wrote, or null when it could not be read. */
  decision: LedgerEntry | null;
  facts: InvoiceFacts;
  /**
   * The invoice hash of the dry run and the raw spend: a hash of the text with a fresh random salt that is never stored.
   * ICR-3b says the invoice hash is the hash of the text, and it still is for process(); this departs from it on purpose.
   * The Canary never pays, its ledger is private, and a plain text hash on a public explorer would let anyone confirm a
   * guessed short text: nothing the Canary puts on chain is derived from the visitor's text alone.
   */
  rawInvoiceHash: string;
  /** The ref of the raw spend: the dry run and the spend carry the same one. */
  ref: string;
  /** Milliseconds left in the attempt. */
  left: () => number;
  /** Set when a step is given up on while it still runs. */
  abandoned: Abandoned;
}

/** The amount of a raw spend: the model's if the contract can read it, else the code's. Never invented. */
function rawAmount(proposal: ModelProposal, facts: InvoiceFacts): string | null {
  if (proposal.amount !== null && isU128(proposal.amount)) return proposal.amount;
  return isU128(facts.amount) ? facts.amount : null;
}

/**
 * The raw gate, in order, each step before anything is consumed: live mode; the code refused; the decision is readable
 * and the model proposed to pay; there is an amount; at least `rawMinRemainingMs` of the attempt is left; the mandate's
 * agent key can pay its gas; the contract's free dry run REFUSES the spend (one it would accept is never sent); then the
 * visitor's and the global counters. Returns a skip, or the spend to send.
 */
async function planRaw(
  c: RawContext,
): Promise<RawStep | { send: { mandateId: number; amount: string; proposal: ModelProposal } }> {
  const { deps, input } = c;
  if (deps.mode !== "live") return skip("mode");
  if (c.outcome.status !== "refused_by_code") return skip("not_refused_by_code");
  if (c.decision === null) return skip("decision_unreadable");
  const proposal = c.decision.body.proposal;
  if (proposal?.action !== "pay") return skip("not_pay");
  // The mandate the proposal names (so the contract's NoMandate stays a demo); the dry run below is what keeps a spend to
  // ANOTHER live mandate from being sent.
  const mandateId = proposal.mandate_id ?? c.mandate.id;
  const amount = rawAmount(proposal, c.facts);
  if (amount === null) return skip("no_amount");
  if (c.left() < CANARY_LIMITS.rawMinRemainingMs) return skip("no_time");

  // An unreadable allowance turns raw mode off: it must never be what lets a spend out.
  let allowance: bigint | null;
  try {
    allowance = await bounded(
      () => deps.agentAllowance(c.mandate),
      c.left,
      "reading the agent key",
      c.abandoned,
    );
  } catch (e) {
    if (e instanceof DeadlineError) return skip("no_time");
    log.warn("canary.allowance_unreadable", { request_id: input.requestId, error: messageOf(e) });
    return skip("allowance_low");
  }
  if (allowance !== null && allowance < CANARY_LIMITS.minAllowanceYocto) {
    return skip("allowance_low");
  }

  // The contract's own free verdict. Raw mode exists to show the contract REFUSING; a spend it would accept (or hold) is
  // a payment, and none is made here.
  try {
    const verdict = await bounded(
      () => c.pb.checkSpend({ mandateId, amount, invoiceHash: c.rawInvoiceHash, ref: c.ref }),
      c.left,
      "the dry run",
      c.abandoned,
    );
    if (verdict.ok) return skip("contract_would_accept");
  } catch (e) {
    if (e instanceof DeadlineError) return skip("no_time");
    log.warn("canary.check_failed", { request_id: input.requestId, error: messageOf(e) });
    return skip("check_failed");
  }

  let refusedBy: RawSkip | null;
  try {
    refusedBy = await claimRawSlot(deps.db, {
      ipHash: input.ipHash,
      visitorHash: input.visitorHash,
    });
  } catch (e) {
    // A counter that cannot be read must not let a spend out.
    log.error("canary.limiter_unavailable", { request_id: input.requestId, error: messageOf(e) });
    return skip("error", "limiter_unavailable");
  }
  if (refusedBy !== null) return skip(refusedBy);
  return { send: { mandateId, amount, proposal } };
}

/**
 * Sends the raw spend ONCE and says what came of it. A return or a throw is recorded and never retried: a throw may
 * come after the transaction reached the chain, and so may running out of time. A refusal by the SDK itself, an error that
 * certainly came before any transaction, and a spend the node refused or that could not be sent (`failed` with no tx
 * hash) are "not sent"; anything else that went wrong is `unconfirmed`, with its tx hash when the error carries one. What
 * the contract returned is the only thing stored as a contract code.
 */
async function sendRaw(
  c: RawContext,
  send: { mandateId: number; amount: string; proposal: ModelProposal },
): Promise<RawStep> {
  let out: SpendOutcome;
  try {
    // No `evidence`: process() attested the proposal at the ledger position it wrote its decision after, so it can
    // never verify at this spend's position, and an amount or mandate that differs from the one the model was shown
    // makes the SDK throw before it writes anything.
    out = await bounded(
      () =>
        c.pb.requestSpend({
          mandateId: send.mandateId,
          amount: send.amount,
          invoiceHash: c.rawInvoiceHash,
          ref: c.ref,
          proposal: send.proposal,
          skipPreflight: true,
        }),
      c.left,
      "the raw spend",
      c.abandoned,
    );
  } catch (e) {
    const code =
      e instanceof DeadlineError
        ? "deadline"
        : (label(e instanceof ProbarionError ? e.code : "error") ?? "error");
    const txHash =
      typeof (e as { txHash?: unknown } | null)?.txHash === "string"
        ? (e as { txHash: string }).txHash
        : null;
    log.error("canary.raw_threw", {
      request_id: c.input.requestId,
      mandate_id: send.mandateId,
      tx: txHash,
      code,
      error: messageOf(e),
    });
    if (PRE_CHAIN_CODES.has(code)) return skip("error", code);
    return {
      raw: { sent: true, status: "unconfirmed", code, txHash },
      fields: {
        ...RAW_PENDING,
        raw: true,
        raw_detail: code,
        contract_status: "unconfirmed",
        tx_hash: txHash,
      },
    };
  }
  const code = label(out.code);
  // The SDK refused it by code (for example an earlier payment of this invoice is unconfirmed): nothing was sent.
  if (out.status === "refused_by_code") {
    const refusal = skip("sdk_refused", code);
    return { ...refusal, fields: { ...refusal.fields, raw_decision_hash: out.decisionHash } };
  }
  // The node refused the signed transaction, or it could not be built and signed: nothing ran, and there is no tx hash.
  if (out.status === "failed" && out.txHash === null) return skip("error", code);
  const byContract = out.status === "refused_by_contract";
  return {
    raw: { sent: true, status: out.status, code, txHash: out.txHash },
    fields: {
      raw: true,
      raw_skipped_reason: null,
      raw_detail: byContract ? null : code,
      contract_status: label(out.status),
      contract_code: byContract ? code : null,
      tx_hash: out.txHash,
      spend_id: out.spendId,
      raw_decision_hash: out.decisionHash,
    },
  };
}

// ---- the cycle --------------------------------------------------------------------------------------------------

/** The facts the SDK is given: only the five InvoiceFacts keys, with the Canary mandate's own purpose. */
function factsOf(text: string, invoiceHash: string, mandate: MandateView): InvoiceFacts {
  // The purpose is the mandate's (there is no purpose document to upload), so the rules reach the payee check and the
  // caps instead of stopping at invoice.po_mismatch.
  const read = extractFacts(text, invoiceHash, mandate.purpose_hash);
  return {
    invoice_hash: read.invoice_hash,
    amount: read.amount,
    po_ref: read.po_ref,
    purpose_hash: read.purpose_hash,
    payee_hint: read.payee_hint,
  };
}

async function readDecision(
  deps: CanaryDeps,
  hash: string,
  at: object,
): Promise<LedgerEntry | null> {
  try {
    return await deps.ledgerByHash(hash);
  } catch (e) {
    log.warn("canary.decision_unreadable", { ...at, error: messageOf(e) });
    return null;
  }
}

/** One attempt, under the tenant's lease: take a slot, open the row, run the SDK, decide raw, send, close the row. */
async function cycle(
  deps: CanaryDeps,
  input: AttemptInput,
  ready: Ready,
  left: () => number,
  abandoned: Abandoned,
): Promise<AttemptResult> {
  const { text, est, mandate, pb } = ready;
  const at = { request_id: input.requestId, tenant: deps.tenant.tenant_id };

  // Attempts in total and per address, below the model limiter: each writes ledger entries and sends an anchor transaction.
  const slot = await takeAttemptSlot(deps.db, input.ipHash);
  if (!slot.ok) return rejected("budget", slot.retryAfterS);

  const textHash = hashInvoice(text);
  const techniques = classify(text);

  // Opened BEFORE the model is called, with the estimate: a run the platform kills still counts against the day's token
  // budget. It is `running` until the cycle moves it on. If it cannot be written nothing has run, and the request fails.
  const { id: attemptId } = await deps.db.rpc<{ id: string }>("canary_attempt_insert", {
    visitor_hash: input.visitorHash,
    ip_hash: input.ipHash,
    is_team: input.isTeam,
    mode: deps.mode,
    text_sha256: textHash,
    text_length: text.length,
    techniques,
    request_id: input.requestId,
    est_tokens: est,
    code_status: "running",
    network: deps.tenant.network,
    via: input.via ?? null,
  });
  // The ref comes from the attempt's id and the time, never from the text's hash.
  const ref = `canary-${attemptId.replaceAll("-", "").slice(0, 20)}-${deps.now().getTime().toString(36)}`;
  const facts = factsOf(text, textHash, mandate);

  /**
   * Writes the row's result columns (a failed write is logged with what happened and never hides the outcome). The row says
   * what is true at this step, so a run that dies leaves an honest row.
   */
  const write = async (fields: Record<string, unknown>, step: string): Promise<boolean> => {
    try {
      await deps.db.rpc("canary_attempt_update", { id: attemptId, ...fields });
      return true;
    } catch (e) {
      log.error("canary.attempt_not_recorded", {
        ...at,
        attempt: attemptId,
        step,
        error: messageOf(e),
        code_status: fields.code_status,
        contract_status: fields.contract_status,
        raw_detail: fields.raw_detail,
        tx: fields.tx_hash,
      });
      return false;
    }
  };
  /** The row of an attempt that ended before it had a code outcome: an error, and why when it was the deadline. */
  const fail = async (deadline: boolean): Promise<AttemptResult> => {
    await write(
      {
        code_status: "error",
        raw_skipped_reason: "error",
        raw_detail: deadline ? "deadline" : null,
      },
      "failed",
    );
    return rejected("failed");
  };

  let outcome: SpendOutcome;
  try {
    outcome = await bounded(
      () => pb.process({ text, facts, ref }),
      left,
      "the model step",
      abandoned,
    );
  } catch (e) {
    // The SDK sends a spend only after a decision, and the Canary's rule refuses every decision: nothing went out. The model
    // may have answered, so the row stays (its estimate counts against the day's budget), closed as an error.
    const deadline = e instanceof DeadlineError || left() <= 0;
    log.error(deadline ? "canary.deadline" : "canary.failed", {
      ...at,
      mandate_id: mandate.id,
      error: messageOf(e),
    });
    return fail(deadline);
  }

  const decision = await readDecision(deps, outcome.decisionHash, at);
  const proposal = decision?.body.proposal ?? null;
  const rule = stoppingRule(decision);
  const usage = outcome.modelUsage ?? null;
  const code = {
    proposal_action: proposal?.action ?? null,
    proposal_mandate_id: proposal?.mandate_id ?? null,
    proposal_amount: proposal?.amount ?? null,
    code_status: codeStatusOf(outcome.status),
    code_rule: label(rule),
    decision_hash: outcome.decisionHash,
    model_prompt_tokens: usage?.promptTokens ?? null,
    model_completion_tokens: usage?.completionTokens ?? null,
  };
  const row = (raw: RawFields) => ({
    ...code,
    ...raw,
    tx_hash: raw.tx_hash ?? outcome.txHash,
    spend_id: raw.spend_id ?? outcome.spendId,
  });
  // As soon as the code has answered: what a run that dies from here on leaves is the code's outcome, nothing sent.
  await write(row(RAW_PENDING), "code outcome");

  const context: RawContext = {
    deps,
    input,
    pb,
    mandate,
    outcome,
    decision,
    facts,
    rawInvoiceHash: hashInvoice(`${randomBytes(32).toString("hex")}\n${text}`),
    ref: `${ref}:raw`,
    left,
    abandoned,
  };
  const plan = await planRaw(context);
  let step: RawStep;
  if ("send" in plan) {
    // The 15 s floor is checked where the spend starts, not only at the gate: the allowance read, the dry run and the
    // counters since then each took their time. Below it nothing is written and nothing is sent.
    const late = () => left() < CANARY_LIMITS.rawMinRemainingMs;
    if (late()) {
      step = skip("no_time");
    } else {
      // Just before the send, the row says a raw spend is on its way (raw, unconfirmed, no skip reason): that is what the
      // row must say if the process dies during the send. If that cannot be written, nothing is sent.
      const pending = await write(
        row({ ...RAW_PENDING, raw: true, contract_status: "unconfirmed" }),
        "raw spend on its way",
      );
      // The write took time too. A skip from here on is what the end of the attempt records (raw: false, no_time), so the
      // row never stays "raw, unconfirmed" for a spend that was not started.
      if (!pending) step = skip("error", "row_unwritable");
      else if (late()) step = skip("no_time");
      else step = await sendRaw(context, plan.send);
    }
  } else {
    step = plan;
  }
  await write(row(step.fields), "end");
  log.info("canary.attempt", {
    ...at,
    code: outcome.status,
    raw: step.raw.sent,
    contract_code: step.fields.contract_code,
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
    raw: step.raw,
  };
}

export async function runAttempt(deps: CanaryDeps, input: AttemptInput): Promise<AttemptResult> {
  // One deadline for the whole attempt, counted from the route's start; every phase shares it.
  const deadlineAt = (input.startedAt ?? deps.now().getTime()) + CANARY_LIMITS.attemptBudgetMs;
  const left = () => deadlineAt - deps.now().getTime();
  const ready = await admit(deps, input, left);
  if ("status" in ready) return ready;
  // A step given up on at the deadline may still be running (it cannot be stopped): then the lease is not released, and
  // runs out by itself after leaseSeconds (more than the route's maxDuration), so no other cycle starts beside it.
  const abandoned: Abandoned = { gaveUp: false };
  const leased = await withLease(
    deps.db,
    deps.tenant.tenant_id,
    "process",
    CANARY_LIMITS.leaseSeconds,
    () => cycle(deps, input, ready, left, abandoned),
    { keep: () => abandoned.gaveUp },
  );
  return leased.acquired ? leased.value : rejected("busy");
}
