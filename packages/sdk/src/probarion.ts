// The Probarion class (interfaces §9): the money path. One cycle turns an invoice into a code decision, an
// optional attested model proposal, a contract `spend` and hash-chained ledger entries, then anchors the
// ledger on chain. The code decides; the model only advises; the contract is authoritative.
// Input checks live in input.ts, the reading of a `spend` answer in spend-outcome.ts.
import { randomUUID } from "node:crypto";
import {
  type AnchorView,
  type AttestationEvidence,
  type CheckSpendVerdict,
  type CustomRule,
  checkAttestation,
  checkRequestBinding,
  computeNonce,
  createEd25519Signer,
  DEFAULT_CONFIDENCE_FLOOR,
  type Decision,
  decide,
  type Hex32,
  type InvoiceFacts,
  KNOWN_SYSTEM_PROMPT_HASHES,
  type KnownSystemPrompt,
  knownSystemPrompt,
  type LedgerEntry,
  type LedgerEntryBody,
  type LedgerSigner,
  type MandateView,
  type ModelProposal,
  NEARAI_BASE_URL,
  type NonceContext,
  nextBodyFields,
  publicKeyFromSecret,
  purposeMatch,
  type RuleResult,
  type SpendRequest,
  type SpendView,
  type VaultConfig,
  ZERO_HEX32,
} from "@probarion/core";
import { type ChainContext, liveInvoiceHashes, spentToday, usedRefs } from "./context.js";
import { envValue } from "./env.js";
import { ConfigError, ContractError, LedgerError, ProbarionError } from "./errors.js";
import {
  callerEvidenceMismatch,
  invalid,
  isRecord,
  messageOf,
  type ProcessInput,
  processInput,
  requestInputsProblemWithoutText,
  spendInput,
} from "./input.js";
import { IntentsClient } from "./intents-client.js";
import {
  FileLedgerStore,
  type LedgerAppendBody,
  LedgerConflictError,
  type LedgerStore,
  ledgerPathFromEnv,
} from "./ledger-store.js";
import { Mutex } from "./mutex.js";
import { NearAiProposer, type ProposeResult } from "./nearai.js";
import { RpcClient, resolveRpcUrls } from "./rpc.js";
import {
  type ModelUsage,
  type OutcomeFields,
  recordSpend,
  refusal,
  refuseForUnresolved,
  type SpendOutcome,
  sendSpend,
  unresolvedPayment,
} from "./spend-outcome.js";
import { NearApiJsSender, type TxOutcome, type TxSender } from "./tx.js";
import { VaultClient } from "./vault-client.js";

export { hashInvoice } from "./input.js";
export type { ModelUsage, SpendOutcome, SpendOutcomeStatus } from "./spend-outcome.js";
export { UNKNOWN_SETTLE_MS } from "./spend-outcome.js";

/** The ledger file when neither `ledger` nor `PROBARION_LEDGER_PATH` is given. */
export const DEFAULT_LEDGER_PATH = ".probarion/ledger.jsonl";

export interface ProbarionOptions {
  network: "mainnet" | "testnet";
  vault: string;
  /** "ed25519:<secret>": the vault's function-call key for `spend` only. */
  agentKey?: string | undefined;
  /** "ed25519:<secret>": the vault's function-call key for `anchor` only. It also signs every ledger entry. */
  ledgerKey?: string | undefined;
  rpcUrls?: string[];
  /** null (or absent) decides rules-only. `systemPrompt` replaces only the proposal persona (plan 04's Canary). */
  model?: {
    provider: "near-ai-cloud";
    apiKey: string;
    model?: string;
    systemPrompt?: string;
  } | null;
  /** Default: `FileLedgerStore(PROBARION_LEDGER_PATH)`, else `.probarion/ledger.jsonl` (an empty value is unset, R12). */
  ledger?: LedgerStore;
  confidenceFloor?: number;
  /** Written into `body.request_id` of every entry this instance writes; otherwise each cycle gets a fresh UUID. */
  requestId?: string | undefined;
}

export interface ProbarionLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Optional dependencies for tests and hosts (interfaces §9 v2). Production code passes nothing. */
export interface ProbarionDeps {
  rpc?: RpcClient;
  agentSender?: TxSender;
  ledgerSender?: TxSender;
  /** `null` decides rules-only even when `opts.model` is set. */
  proposer?: NearAiProposer | null;
  nearaiBaseUrl?: string;
  now?: () => Date;
  requestId?: () => string;
  /** Default: one structured JSON line per warning on `console.warn`. */
  logger?: ProbarionLogger;
  expectedCodeHashes?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  /** Placeholders that Task 14 (`snapshot`, `verify`) finalizes; this class only stores them. */
  archivalRpc?: RpcClient;
  preLedgerDecisionHashes?: readonly Hex32[];
  evidenceDir?: string;
}

/** The default logger: one JSON line per warning, so a host's log pipeline can parse it. */
const CONSOLE_LOGGER: ProbarionLogger = {
  warn: (message, meta) => {
    console.warn(JSON.stringify({ level: "warn", source: "@probarion/sdk", message, ...meta }));
  },
};

const RAW_MODE_DETAIL = "preflight skipped by caller";

function firstRule(rules: readonly RuleResult[], outcome: RuleResult["outcome"]): string | null {
  return rules.find((r) => r.outcome === outcome)?.id ?? null;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Parses a secret key for its public half; a bad key is a `ConfigError` that names the option, never the key. */
function publicKeyOf(secretKey: string, option: string): string {
  try {
    return publicKeyFromSecret(secretKey);
  } catch (error) {
    throw new ConfigError(`${option} is not a valid ed25519 secret key: ${messageOf(error)}`);
  }
}

interface Keys {
  agentPk: string;
  ledgerPk: string;
  ledgerSign: LedgerSigner;
}

interface ModelStep {
  proposal: ModelProposal | null;
  evidence: AttestationEvidence | null;
  attestationOk: boolean | null;
  modelUsage: ModelUsage | null;
}

const NO_MODEL: ModelStep = {
  proposal: null,
  evidence: null,
  attestationOk: null,
  modelUsage: null,
};

interface Cycle {
  keys: Keys;
  decision: Decision;
  /** The nonce mandate: the code's pre-selection, recorded as the decision entry's `mandate_id`. */
  entryMandateId: number | null;
  /** The mandate the spend would go to (for the settlement chain). */
  mandate: MandateView | null;
  invoiceHash: Hex32;
  ref: string;
  proposal: ModelProposal | null;
  evidence: AttestationEvidence | null;
  /** The position the decision (and its nonce) was made against; the decision append expects it. */
  expected: { seq: number; prev_link: Hex32 };
  now: Date;
  skipPreflight: boolean;
}

/**
 * The Probarion client for one vault.
 *
 * With no keys and `model: null` the instance is read-only: `mandates.*`, `spends.get`, `anchors.latest`
 * and `checkSpend` work (Task 14 adds `snapshot()` and `verify()`); `process` and `requestSpend` throw
 * `ConfigError` before reading or writing anything.
 *
 * Serialization: `process` and `requestSpend` run in one critical section per instance (a `Mutex`). The
 * decision entry is written with a compare-and-append (`LedgerStore.append(..., { expect })`), checked under
 * the store's lock (Task 12's file lock across processes): it is written only at the position its nonce was
 * computed for.
 *
 * LEDGER_FORK_RISK: the window read chain → decide → append decision → spend → append payment is NOT one
 * transaction across processes or instances.
 * - Two writers on one ledger file: the one whose decision append finds the head moved throws
 *   `LedgerConflictError` ("ledger moved since this decision was attested; retry"). It writes no entry and
 *   sends no spend, and it is never retried automatically. Its payment entry, written later, needs no position.
 * - Two writers on one vault both decide from the same chain state: the contract still refuses the second
 *   spend of an invoice or a ref.
 * - Two writers with two ledger files fork the vault's history. The contract checks only that anchor seqs are
 *   consecutive and counts do not decrease, so it accepts both writers' anchors, interleaved. The anchors then
 *   mix two histories, and verify check c fails for the ranges anchored from the other file. A cycle that
 *   finds the on-chain count above its own ledger's length warns and does not anchor. Plan 05's MCP guard
 *   compares `anchors.latest()` with the local ledger; this class does not try to solve it.
 */
export class Probarion {
  readonly network: "mainnet" | "testnet";
  readonly vaultId: string;
  readonly spends: { get(id: number): Promise<SpendView | null> };
  /** The vault's latest on-chain anchor (plan 05's MCP ledger-fork guard compares it with the local ledger). */
  readonly anchors: { latest(): Promise<AnchorView | null> };
  readonly mandates: {
    list(): Promise<MandateView[]>;
    get(id: number): Promise<MandateView | null>;
  };
  readonly rules: { add(rule: CustomRule): void };

  private readonly deps: ProbarionDeps;
  private readonly logger: ProbarionLogger;
  private readonly rpc: RpcClient;
  private readonly vault: VaultClient;
  private readonly ledger: LedgerStore;
  private readonly proposer: NearAiProposer | null;
  private readonly agentSender: TxSender | undefined;
  private readonly agentPk: string | null;
  private readonly ledgerPk: string | null;
  private readonly ledgerSign: LedgerSigner | null;
  private readonly confidenceFloor: number;
  private readonly fixedRequestId: string | undefined;
  /**
   * The system prompts A8 accepts for this instance: core's defaults plus `opts.model.systemPrompt` when set.
   * Write-time A8 uses it; Task 14's `verify` must use the same list (see the Task 13 report).
   */
  private readonly systemPrompts: readonly KnownSystemPrompt[];
  private readonly customRules: CustomRule[] = [];
  private readonly lock = new Mutex();
  private lastAnchor: { seq: number; count: number } | null = null;

  constructor(opts: ProbarionOptions, deps: ProbarionDeps = {}) {
    if (!isRecord(opts)) throw new ConfigError("Probarion needs its options");
    if (opts.network !== "mainnet" && opts.network !== "testnet") {
      throw new ConfigError('network must be "mainnet" or "testnet"');
    }
    if (typeof opts.vault !== "string" || opts.vault.length === 0) {
      throw new ConfigError("vault must be the vault account id");
    }
    const env = deps.env ?? process.env;
    this.network = opts.network;
    this.vaultId = opts.vault;
    this.deps = deps;
    this.logger = deps.logger ?? CONSOLE_LOGGER;
    this.fixedRequestId = nonEmpty(opts.requestId);
    this.rpc = deps.rpc ?? new RpcClient({ urls: resolveRpcUrls(opts.network, opts.rpcUrls, env) });
    const rpcUrl = (): string => this.rpc.currentUrl;

    const agentKey = nonEmpty(opts.agentKey);
    const ledgerKey = nonEmpty(opts.ledgerKey);
    this.agentSender =
      deps.agentSender ??
      (agentKey === undefined
        ? undefined
        : new NearApiJsSender({ accountId: opts.vault, secretKey: agentKey, rpcUrl }));
    this.agentPk =
      agentKey === undefined
        ? (this.agentSender?.publicKey ?? null)
        : publicKeyOf(agentKey, "agentKey");
    if (this.agentSender !== undefined && this.agentSender.publicKey !== this.agentPk) {
      throw new ConfigError("the injected agent sender signs with another key than agentKey");
    }
    const ledgerSender =
      deps.ledgerSender ??
      (ledgerKey === undefined
        ? undefined
        : new NearApiJsSender({ accountId: opts.vault, secretKey: ledgerKey, rpcUrl }));
    this.ledgerPk = ledgerKey === undefined ? null : publicKeyOf(ledgerKey, "ledgerKey");
    this.ledgerSign = ledgerKey === undefined ? null : createEd25519Signer(ledgerKey);
    this.vault = new VaultClient(opts.vault, this.rpc, {
      agent: this.agentSender,
      ledger: ledgerSender,
    });
    this.ledger = opts.ledger ?? new FileLedgerStore(ledgerPathFromEnv(env, DEFAULT_LEDGER_PATH));

    const floor = opts.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
    if (typeof floor !== "number" || !(floor >= 0 && floor <= 1)) {
      throw new ConfigError("confidenceFloor must be a number from 0 to 1");
    }
    this.confidenceFloor = floor;

    const model = opts.model ?? null;
    if (model !== null) {
      if (!isRecord(model) || model.provider !== "near-ai-cloud") {
        throw new ConfigError(
          'model.provider must be "near-ai-cloud" (or pass model: null to decide rules-only)',
        );
      }
      if (typeof model.apiKey !== "string" || model.apiKey.trim() === "") {
        throw new ConfigError(
          "model.apiKey (NEARAI_API_KEY) is required for the model step; pass model: null to decide rules-only",
        );
      }
      if (
        model.systemPrompt !== undefined &&
        (typeof model.systemPrompt !== "string" || model.systemPrompt.trim() === "")
      ) {
        throw new ConfigError(
          "model.systemPrompt must not be empty; omit it to use the default prompt",
        );
      }
    }
    this.systemPrompts =
      model?.systemPrompt === undefined
        ? KNOWN_SYSTEM_PROMPT_HASHES
        : [
            ...KNOWN_SYSTEM_PROMPT_HASHES,
            knownSystemPrompt("model.systemPrompt", model.systemPrompt),
          ];
    if (deps.proposer !== undefined) {
      this.proposer = deps.proposer;
    } else if (model !== null) {
      try {
        this.proposer = new NearAiProposer({
          apiKey: model.apiKey,
          model: model.model ?? envValue(env, "NEARAI_MODEL"),
          baseUrl: deps.nearaiBaseUrl ?? NEARAI_BASE_URL,
          ...(model.systemPrompt === undefined ? {} : { systemPrompt: model.systemPrompt }),
        });
      } catch (error) {
        throw new ConfigError(`the model step cannot be set up: ${messageOf(error)}`);
      }
    } else {
      this.proposer = null;
    }

    this.spends = { get: (id: number) => this.vault.getSpend(id) };
    this.anchors = { latest: async () => (await this.vault.listAllAnchors()).at(-1) ?? null };
    this.mandates = {
      list: () => this.vault.listAllMandates(),
      get: (id: number) => this.vault.getMandate(id),
    };
    this.rules = {
      add: (rule: CustomRule) => {
        const id: unknown = isRecord(rule) ? rule.id : undefined;
        if (typeof id !== "string" || !id.startsWith("custom.") || id.length === "custom.".length) {
          throw new ConfigError(`custom rule id must start with "custom.", got ${String(id)}`);
        }
        if (typeof rule.check !== "function") {
          throw new ConfigError(`custom rule ${id} has no check()`);
        }
        this.customRules.push(rule);
      },
    };
  }

  // ---------- reads ----------

  /** The contract's free dry run of `spend` (no ledger entry, no transaction). */
  async checkSpend(input: {
    mandateId: number;
    amount: string;
    invoiceHash: Hex32;
    ref: string;
  }): Promise<{
    ok: boolean;
    code: string | null;
    would_hold: boolean;
  }> {
    const signerPk = this.agentPk ?? (await this.vault.getMandate(input.mandateId))?.agent_pk;
    if (signerPk === undefined) {
      throw new ConfigError(
        `mandate ${input.mandateId} does not exist and no agent key is configured`,
      );
    }
    const verdict: CheckSpendVerdict = await this.vault.checkSpend(
      {
        mandate_id: input.mandateId,
        amount: input.amount,
        invoice_hash: input.invoiceHash,
        ref: input.ref,
        decision_hash: ZERO_HEX32,
      },
      signerPk,
    );
    return verdict;
  }

  // ---------- the money path ----------

  /**
   * Full cycle: (optional) model → policy → ledger decision entry → contract spend → ledger outcome entry →
   * anchor. `facts.invoice_hash` must equal `hashInvoice(text)` and `facts.po_ref` must be null or a verbatim
   * substring of `text`, otherwise `ProbarionError` `InvalidInput` is thrown before any write (ICR-6). An
   * unconfirmed earlier payment of the same invoice refuses the cycle by code until it settles: until the chain
   * shows its spend, or until `UNKNOWN_SETTLE_MS` (48 h) after it, when its transaction can no longer pay.
   */
  process(invoice: { text: string; facts: InvoiceFacts; ref: string }): Promise<SpendOutcome> {
    return this.lock.run(async () => {
      const input = processInput(invoice);
      const keys = this.requireKeys();
      const now = this.now();
      const ctx = await this.loadContext();
      this.assertLedgerKey(ctx.config, keys);
      const entries = await this.ledger.all();
      const expected = nextBodyFields(entries.at(-1) ?? null);
      const unresolved = unresolvedPayment(entries, input.facts.invoice_hash, ctx.spends, now);
      // The nonce mandate: the decision entry records it and the policy refuses any decision that leaves it
      // (invoice.po_mismatch), so the nonce recomputed from the entry always matches.
      const candidate = purposeMatch(ctx.mandates, input.facts.purpose_hash, now, keys.agentPk);
      // A cycle refused for an unresolved earlier payment spends no model tokens.
      const model =
        unresolved === null ? await this.modelStep(input, candidate, expected) : NO_MODEL;
      let decision = decide({
        vault: this.vaultId,
        agentPk: keys.agentPk,
        now,
        invoice: input.facts,
        proposal: model.proposal,
        attestationOk: model.attestationOk,
        mandates: ctx.mandates,
        paidInvoiceHashes: liveInvoiceHashes(ctx.spends),
        usedRefs: usedRefs(ctx.spends),
        intentsBalance: await this.intentsBalanceFor(candidate, ctx.config),
        frozen: ctx.config.frozen,
        confidenceFloor: this.confidenceFloor,
        customRules: [...this.customRules],
        ref: input.ref,
        daily: this.daily(ctx, now),
      });
      if (unresolved !== null) decision = refuseForUnresolved(decision, unresolved);
      const outcome = await this.execute({
        keys,
        decision,
        entryMandateId: candidate?.id ?? null,
        mandate: ctx.mandates.find((m) => m.id === decision.mandate_id) ?? null,
        invoiceHash: input.facts.invoice_hash,
        ref: input.ref,
        proposal: model.proposal,
        evidence: model.evidence,
        expected,
        now,
        skipPreflight: false,
      });
      return { ...outcome, modelUsage: model.modelUsage };
    });
  }

  /**
   * Low-level: the caller already decided; this still writes the ledger and checks the contract, against the
   * named mandate only. No recipient parameter exists.
   *
   * Caller evidence must have been made for this spend: its `request_inputs` must show this amount, the
   * mandate's purpose and exactly this mandate (immutable fields), else `InvalidInput` before any write. It is
   * then written only if it passes A1–A7 and the text-free part of A8 at this ledger position; otherwise it
   * is dropped and the decision is rules-only.
   *
   * `skipPreflight: true` (Canary raw mode only) writes a decision entry (verdict allow, rule
   * `custom.raw_mode`), skips the code rules and `check_spend`, and always sends `spend`: a contract panic
   * comes back as `refused_by_contract` with the bare code and the failed transaction's hash. The one
   * exception is an unconfirmed payment of the same invoice that has not settled yet (see `process`): it
   * refuses by code even in raw mode.
   */
  requestSpend(input: {
    mandateId: number;
    amount: string;
    invoiceHash: Hex32;
    ref: string;
    proposal?: ModelProposal | null;
    evidence?: AttestationEvidence | null;
    skipPreflight?: boolean;
  }): Promise<SpendOutcome> {
    return this.lock.run(async () => {
      const s = spendInput(input);
      const keys = this.requireKeys();
      const now = this.now();
      const ctx = await this.loadContext();
      this.assertLedgerKey(ctx.config, keys);
      const entries = await this.ledger.all();
      const expected = nextBodyFields(entries.at(-1) ?? null);
      const mandate = ctx.mandates.find((m) => m.id === s.mandateId) ?? null;
      const unresolved = unresolvedPayment(entries, s.invoiceHash, ctx.spends, now);

      let evidence = s.evidence;
      let attestationOk: boolean | null = null;
      if (evidence !== null) {
        const mismatch = callerEvidenceMismatch(evidence, s, mandate);
        if (mismatch !== null) {
          throw invalid(`the caller's evidence was not made for this spend: ${mismatch}`);
        }
        const context: NonceContext = {
          vault: this.vaultId,
          prev_link: expected.prev_link,
          invoice_hash: s.invoiceHash,
          mandate_id: s.mandateId,
          seq: expected.seq,
        };
        const problem = await this.evidenceProblem(evidence, s.proposal, null, context);
        if (problem === null) {
          attestationOk = true;
        } else {
          this.warn(`the caller's evidence is not used (${problem}); deciding rules-only`);
          evidence = null;
          attestationOk = false;
        }
      }
      const base = {
        keys,
        entryMandateId: s.mandateId,
        mandate,
        invoiceHash: s.invoiceHash,
        ref: s.ref,
        proposal: s.proposal,
        evidence,
        expected,
        now,
      };
      if (s.skipPreflight) {
        let raw: Decision = {
          verdict: "allow",
          mandate_id: s.mandateId,
          amount: s.amount,
          rules: [{ id: "custom.raw_mode", outcome: "pass", detail: RAW_MODE_DETAIL }],
          decided_by: "rules-only",
        };
        if (unresolved !== null) raw = refuseForUnresolved(raw, unresolved);
        return {
          ...(await this.execute({ ...base, decision: raw, skipPreflight: true })),
          modelUsage: null,
        };
      }
      let decision = decide({
        vault: this.vaultId,
        agentPk: keys.agentPk,
        now,
        invoice: {
          invoice_hash: s.invoiceHash,
          amount: s.amount,
          po_ref: null,
          purpose_hash: mandate?.purpose_hash ?? null,
          payee_hint: null,
        },
        proposal: s.proposal,
        attestationOk,
        mandates: mandate === null ? [] : [mandate],
        paidInvoiceHashes: liveInvoiceHashes(ctx.spends),
        usedRefs: usedRefs(ctx.spends),
        intentsBalance: await this.intentsBalanceFor(mandate, ctx.config),
        frozen: ctx.config.frozen,
        confidenceFloor: this.confidenceFloor,
        customRules: [...this.customRules],
        ref: s.ref,
        daily: this.daily(ctx, now),
      });
      if (unresolved !== null) decision = refuseForUnresolved(decision, unresolved);
      return {
        ...(await this.execute({ ...base, decision, skipPreflight: false })),
        modelUsage: null,
      };
    });
  }

  // ---------- internals ----------

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private requestId(): string {
    return this.fixedRequestId ?? (this.deps.requestId ?? randomUUID)();
  }

  private warn(message: string): void {
    this.logger.warn(message, { vault: this.vaultId });
  }

  private requireKeys(): Keys {
    if (this.agentPk === null || this.agentSender === undefined) {
      throw new ConfigError(
        "this instance is read-only: process() and requestSpend() need agentKey (PROBARION_AGENT_KEY), the vault's function-call key for spend",
      );
    }
    if (this.agentSender.accountId !== this.vaultId) {
      throw new ConfigError(
        `the agent key signs as ${this.agentSender.accountId}, but this vault is ${this.vaultId}: function-call keys live on the vault account itself`,
      );
    }
    if (this.ledgerSign === null || this.ledgerPk === null) {
      throw new ConfigError(
        "process() and requestSpend() need ledgerKey (PROBARION_LEDGER_KEY): every ledger entry is signed with it",
      );
    }
    return { agentPk: this.agentPk, ledgerPk: this.ledgerPk, ledgerSign: this.ledgerSign };
  }

  /** Entries signed by any other key than the vault's ledger key would fail verify check a forever. */
  private assertLedgerKey(config: VaultConfig, keys: Keys): void {
    if (config.ledger_key === keys.ledgerPk) return;
    throw new ConfigError(
      config.ledger_key === null
        ? "the vault has no ledger key yet (set_ledger_key): entries signed now could never be verified"
        : `ledgerKey is ${keys.ledgerPk}, but the vault's ledger key is ${config.ledger_key}: its entries would fail verify check a`,
    );
  }

  private async loadContext(): Promise<ChainContext> {
    const [config, mandates, spends] = await Promise.all([
      this.vault.getConfig(),
      this.vault.listAllMandates(),
      this.vault.listAllSpends(),
    ]);
    return { config, mandates, spends };
  }

  /** `decide()` always gets the chain's daily view: the backstop and the total of the UTC day of `now`. */
  private daily(ctx: ChainContext, now: Date): { backstop: string; spent_today: string } {
    return { backstop: ctx.config.daily_backstop, spent_today: spentToday(ctx.spends, now) };
  }

  private async intentsBalanceFor(
    mandate: MandateView | null,
    config: VaultConfig,
  ): Promise<bigint | null> {
    if (mandate === null || mandate.payee.type !== "intents") return null;
    try {
      return await new IntentsClient(config.intents, this.rpc).poaBalance(
        this.vaultId,
        mandate.payee.asset,
      );
    } catch (error) {
      this.warn(`could not read the POA balance; intents.balance_low holds: ${messageOf(error)}`);
      return null;
    }
  }

  /**
   * The model step, against the nonce mandate. Any failure (any `NearAiError`, including a response over
   * 64 KiB, or evidence that A1–A7 or A8 refuse at this ledger position) gives `proposal: null,
   * attestationOk: false`: the decision is rules-only and records `model.unavailable`. Token usage is kept
   * whenever the model answered.
   */
  private async modelStep(
    input: ProcessInput,
    candidate: MandateView | null,
    expected: { seq: number; prev_link: Hex32 },
  ): Promise<ModelStep> {
    if (this.proposer === null || candidate === null) return NO_MODEL;
    const context: NonceContext = {
      vault: this.vaultId,
      prev_link: expected.prev_link,
      invoice_hash: input.facts.invoice_hash,
      mandate_id: candidate.id,
      seq: expected.seq,
    };
    const unavailable = (modelUsage: ModelUsage | null): ModelStep => ({
      proposal: null,
      evidence: null,
      attestationOk: false,
      modelUsage,
    });
    let result: ProposeResult;
    try {
      result = await this.proposer.propose({
        invoiceText: input.text,
        mandates: [candidate],
        nonce: computeNonce(context),
        facts: input.facts,
      });
    } catch (error) {
      this.warn(`model unavailable; deciding rules-only: ${messageOf(error)}`);
      return unavailable(null);
    }
    const modelUsage =
      result.usage === null ? null : { model: result.evidence.model, ...result.usage };
    const problem = await this.evidenceProblem(
      result.evidence,
      result.proposal,
      input.text,
      context,
    );
    if (problem !== null) {
      this.warn(`model unavailable: ${problem}; deciding rules-only`);
      return unavailable(modelUsage);
    }
    return {
      proposal: result.proposal,
      evidence: result.evidence,
      attestationOk: true,
      modelUsage,
    };
  }

  /**
   * Null when `evidence` passes what a later `verify` will check for this entry: A1–A7 with the entry's own
   * nonce and proposal, and A8 with the invoice text (or, without the text, A8's text-free part).
   */
  private async evidenceProblem(
    evidence: AttestationEvidence,
    proposal: ModelProposal | null,
    text: string | null,
    context: NonceContext,
  ): Promise<string | null> {
    const attestation = await checkAttestation(evidence, computeNonce(context), proposal);
    if (!attestation.ok) {
      const failed = attestation.checks.filter((c) => !c.pass).map((c) => `${c.id} (${c.detail})`);
      return `attestation checks failed: ${failed.join("; ")}`;
    }
    if (text === null) {
      return requestInputsProblemWithoutText(evidence, context, this.systemPrompts);
    }
    const a8 = checkRequestBinding(evidence, text, context, { systemPrompts: this.systemPrompts });
    return a8.pass ? null : `A8 failed: ${a8.detail}`;
  }

  /**
   * Writes the decision entry at exactly the attested position (compare-and-append). A `LedgerConflictError`
   * means another writer appended first: nothing was written and nothing is sent.
   */
  private async appendDecision(c: Cycle): Promise<LedgerEntry> {
    const d = c.decision;
    let entry: LedgerEntry;
    try {
      entry = await this.ledger.append(
        {
          v: 1,
          vault: this.vaultId,
          kind: "decision",
          at: c.now.toISOString(),
          request_id: this.requestId(),
          mandate_id: c.entryMandateId,
          invoice_hash: c.invoiceHash,
          amount: d.amount,
          proposal: c.proposal,
          evidence: c.evidence,
          rules: d.rules,
          verdict: d.verdict,
          decided_by: d.decided_by,
          contract: null,
          settlement: null,
          refs: null,
        },
        c.keys.ledgerSign,
        { expect: c.expected },
      );
    } catch (error) {
      if (!(error instanceof LedgerConflictError)) throw error;
      throw new LedgerConflictError(
        `ledger moved since this decision was attested; retry (no entry was written and no spend was sent): ${error.message}`,
        error.expected,
        error.actual,
      );
    }
    // A LedgerStore that ignores `expect` (a custom store) is caught here: the entry exists, but no spend
    // is sent for a decision that is not at the position it was attested for.
    if (entry.body.seq !== c.expected.seq || entry.body.prev_link !== c.expected.prev_link) {
      throw new LedgerError(
        `the decision landed at seq ${entry.body.seq}, not at the attested seq ${c.expected.seq}: the ledger store did not compare-and-append; no spend was sent (LEDGER_FORK_RISK)`,
      );
    }
    return entry;
  }

  private async execute(c: Cycle): Promise<Omit<SpendOutcome, "modelUsage">> {
    const d = c.decision;
    if (d.verdict !== "refuse" && d.mandate_id !== c.entryMandateId) {
      throw new ProbarionError(
        `internal: decision mandate ${String(d.mandate_id)} differs from the nonce mandate ${String(c.entryMandateId)}`,
        "Internal",
      );
    }
    const decisionEntry = await this.appendDecision(c);
    const decisionHash = decisionEntry.body_hash;
    /** `paymentWritten` is false only when a payment entry was due and could not be written. */
    const finish = async (
      fields: OutcomeFields,
      last: LedgerEntry | null,
      paymentWritten = true,
    ): Promise<Omit<SpendOutcome, "modelUsage">> => ({
      ...fields,
      ledgerSeq: (last ?? decisionEntry).body.seq,
      decisionHash,
      anchorTxHash: await this.anchorTail(),
      ...(paymentWritten ? {} : { ledgerComplete: false as const }),
    });

    if (d.verdict === "refuse" || d.mandate_id === null || d.amount === null) {
      const code = firstRule(d.rules, "refuse");
      return finish({ status: "refused_by_code", spendId: null, code, txHash: null }, null);
    }

    const request: SpendRequest = {
      mandate_id: d.mandate_id,
      amount: d.amount,
      invoice_hash: c.invoiceHash,
      ref: c.ref,
      decision_hash: decisionHash,
    };
    const payment = (
      rules: RuleResult[],
      contract: NonNullable<LedgerEntryBody["contract"]>,
      settlement: LedgerEntryBody["settlement"] = null,
    ) =>
      this.appendPayment(
        {
          v: 1,
          vault: this.vaultId,
          kind: "payment",
          at: this.now().toISOString(),
          request_id: decisionEntry.body.request_id,
          mandate_id: request.mandate_id,
          invoice_hash: request.invoice_hash,
          amount: request.amount,
          proposal: null,
          evidence: null,
          rules,
          verdict: null,
          decided_by: null,
          contract,
          settlement,
          refs: { decision_body_hash: decisionHash },
        },
        c.keys.ledgerSign,
      );

    if (!c.skipPreflight) {
      const verdict = await this.vault.checkSpend(request, c.keys.agentPk);
      if (!verdict.ok) {
        const entry = await payment(
          [refusal(`check_spend refused: ${verdict.code ?? "no code"}`)],
          { code: verdict.code, tx_hash: null, spend_id: null, status: "check_failed" },
        );
        const fields: OutcomeFields = {
          status: "refused_by_contract",
          spendId: null,
          code: verdict.code,
          txHash: null,
        };
        return finish(fields, entry, entry !== null);
      }
      if (d.verdict === "hold" && !verdict.would_hold) {
        // The code holds but the contract would pay at once: hold off-chain, send nothing.
        const code = firstRule(d.rules, "hold");
        return finish({ status: "held", spendId: null, code, txHash: null }, null);
      }
    }

    const record = recordSpend(await sendSpend(this.vault, request), c.mandate?.payee, c.ref);
    if (record.warning !== null) this.warn(record.warning);
    const entry = await payment(record.rules, record.contract, record.settlement);
    return finish(record.fields, entry, entry !== null);
  }

  /** A payment entry that cannot be written must not hide the outcome of a spend that went through. */
  private async appendPayment(
    body: LedgerAppendBody,
    sign: LedgerSigner,
  ): Promise<LedgerEntry | null> {
    try {
      return await this.ledger.append(body, sign);
    } catch (error) {
      const c = body.contract;
      this.warn(
        `the payment entry could not be written (${messageOf(error)}); the outcome stands: spend ${String(c?.spend_id ?? "-")}, status ${String(c?.status)}, tx ${String(c?.tx_hash ?? "-")}. The chain keeps the spend and its decision_hash; the outcome reports ledgerComplete: false.`,
      );
      return null;
    }
  }

  private async fetchLastAnchor(): Promise<{ seq: number; count: number }> {
    const last = (await this.vault.listAllAnchors()).at(-1);
    const value = last === undefined ? { seq: 0, count: 0 } : { seq: last.seq, count: last.count };
    this.lastAnchor = value;
    return value;
  }

  private warnAnchorAhead(count: number, length: number): void {
    this.warn(
      `the vault's last anchor covers ${count} entries but this ledger holds ${length}: it is not the anchored ledger (LEDGER_FORK_RISK)`,
    );
  }

  /**
   * Anchors the ledger tail: root = link of the last entry, count = ledger length. An anchor covers every entry
   * up to its count, so a failed anchor is only logged: the next cycle anchors the whole tail. Never throws.
   */
  private async anchorTail(): Promise<string | null> {
    if (!this.vault.canAnchor) {
      this.warn("no ledger key sender: the ledger was not anchored");
      return null;
    }
    try {
      const entries = await this.ledger.all();
      const last = entries.at(-1);
      if (last === undefined) return null;
      let anchored = this.lastAnchor ?? (await this.fetchLastAnchor());
      if (anchored.count > entries.length) {
        this.warnAnchorAhead(anchored.count, entries.length);
        return null;
      }
      if (anchored.count === entries.length) return null;
      let tx: TxOutcome;
      try {
        tx = await this.vault.anchor(anchored.seq + 1, last.link, entries.length);
      } catch (error) {
        if (!(error instanceof ContractError && error.vaultCode === "BadSeq")) throw error;
        anchored = await this.fetchLastAnchor();
        if (anchored.count > entries.length) {
          this.warnAnchorAhead(anchored.count, entries.length);
          return null;
        }
        if (anchored.count === entries.length) return null;
        tx = await this.vault.anchor(anchored.seq + 1, last.link, entries.length);
      }
      this.lastAnchor = { seq: anchored.seq + 1, count: entries.length };
      return tx.txHash;
    } catch (error) {
      this.lastAnchor = null;
      this.warn(`anchoring failed; the next cycle anchors the tail: ${messageOf(error)}`);
      return null;
    }
  }
}
