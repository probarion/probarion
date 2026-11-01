// The Probarion class (interfaces §9): the money path. One cycle turns an invoice into a code decision, an
// optional attested model proposal, a contract `spend` and hash-chained ledger entries, then anchors the
// ledger on chain. The code decides; the model only advises; the contract is authoritative.
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
  isHex32,
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
  type PayeeHint,
  type ProposalRequestInputs,
  parseModelProposal,
  proposalRequestInputsProblem,
  publicKeyFromSecret,
  purposeMatch,
  type RuleResult,
  type SpendRequest,
  type SpendResult,
  type SpendView,
  sha256Hex,
  utf8,
  type VaultConfig,
  ZERO_HEX32,
} from "@probarion/core";
import { type ChainContext, liveInvoiceHashes, spentToday, usedRefs } from "./context.js";
import { envValue } from "./env.js";
import {
  ConfigError,
  ContractError,
  isVaultErrorCode,
  LedgerError,
  ProbarionError,
  TxOutcomeUnknownError,
  TxRejectedError,
} from "./errors.js";
import { IntentsClient } from "./intents-client.js";
import {
  FileLedgerStore,
  type LedgerAppendBody,
  type LedgerStore,
  ledgerPathFromEnv,
} from "./ledger-store.js";
import { Mutex } from "./mutex.js";
import { NearAiProposer, type ProposeResult } from "./nearai.js";
import { RpcClient, resolveRpcUrls } from "./rpc.js";
import { isOutOfNearCode, NearApiJsSender, type TxOutcome, type TxSender } from "./tx.js";
import { type SpendTxResult, VaultClient } from "./vault-client.js";

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
 * - `paid`, `burned`: settled on NEAR. A burn is not `settled` yet: the Base or Solana release is observed
 *   later, so `process` never returns `settled`.
 * - `failed`: definitely not paid. `code` is the payout status (`failed`, ...) when the vault released the
 *   spend, else why the transaction did not run (`TxSendFailed`, a `TxRejectedError` kind such as
 *   `NotEnoughAllowance`, `LackBalanceForState` / `NotEnoughBalance`, `TxFailed`).
 * - `unconfirmed`: `spend` was sent and may have paid. `txHash` is set whenever the sender knows it. Never
 *   send it again, least of all under a fresh `ref`: resolve it with `VaultClient.resolveSpend(txHash)` or by
 *   looking the spend up by `ref`. A transaction that never landed stays unknown until its block-hash window
 *   expires (about 1 day). `code` says what is unknown (`TxOutcomeUnknown`, `pending`, `callback_failed`, ...).
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
  logger?: ProbarionLogger;
  expectedCodeHashes?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  /** Placeholders that Task 14 (`snapshot`, `verify`) finalizes; this class only stores them. */
  archivalRpc?: RpcClient;
  preLedgerDecisionHashes?: readonly Hex32[];
  evidenceDir?: string;
}

const NOT_TEXT =
  "hashInvoice takes the invoice text, as a string or as its UTF-8 bytes; this is not UTF-8 text. Pass the extracted text (the text the model is shown); a PDF's file hash belongs in document_sha256";

/**
 * The invoice hash (ICR-3b): `sha256Hex(utf8(text))`, the hash of the exact text the model is shown. Bytes
 * must be valid UTF-8 and hash the same as their text (a BOM is kept, so they hash as they are). Anything
 * else throws `ProbarionError` `InvalidInput`.
 */
export function hashInvoice(content: string | Uint8Array): Hex32 {
  if (typeof content === "string") return sha256Hex(utf8(content));
  if (content instanceof Uint8Array) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      throw new ProbarionError(NOT_TEXT, "InvalidInput");
    }
    return sha256Hex(utf8(text));
  }
  throw new ProbarionError(NOT_TEXT, "InvalidInput");
}

// ---------- input checks: all of them run before anything is read, sent or written ----------

const REF_MAX_BYTES = 64; // contracts/vault/src/validate.rs `is_ref`
const U128_MAX = (1n << 128n) - 1n;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,38})$/;
const LONE_SURROGATE_RE = /[\u{D800}-\u{DFFF}]/u;

function invalid(message: string): ProbarionError {
  return new ProbarionError(message, "InvalidInput");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkRef(ref: unknown): string {
  if (typeof ref !== "string" || LONE_SURROGATE_RE.test(ref)) {
    throw invalid("ref must be well-formed text of 1 to 64 bytes");
  }
  const bytes = utf8(ref).length;
  if (bytes < 1 || bytes > REF_MAX_BYTES) {
    throw invalid(`ref must be 1 to ${REF_MAX_BYTES} bytes, got ${bytes}`);
  }
  return ref;
}

function checkPayeeHint(raw: unknown): PayeeHint | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw invalid("facts.payee_hint must be an object or null");
  const hint: PayeeHint = {};
  for (const key of ["near_account", "address", "name"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw invalid(`facts.payee_hint.${key} must be text`);
    hint[key] = value;
  }
  if (raw.chain !== undefined) {
    if (raw.chain !== "base" && raw.chain !== "solana") {
      throw invalid("facts.payee_hint.chain must be base or solana");
    }
    hint.chain = raw.chain;
  }
  return hint;
}

interface ProcessInput {
  text: string;
  facts: InvoiceFacts;
  ref: string;
}

/**
 * ICR-6: `facts.invoice_hash === hashInvoice(text)` (ICR-3b) and `facts.po_ref` null or a verbatim substring
 * of `text` (ICR-3c), as `NearAiProposer.propose` and A8 require. An empty `po_ref` is written as null. The
 * facts are rebuilt with exactly their five keys, so nothing else reaches the model or the ledger.
 */
function processInput(invoice: unknown): ProcessInput {
  if (!isRecord(invoice)) throw invalid("process() takes { text, facts, ref }");
  const { text, facts } = invoice;
  if (typeof text !== "string") {
    throw invalid("invoice.text must be the invoice text (a string): the text the model is shown");
  }
  if (!isRecord(facts)) throw invalid("invoice.facts must be an object");
  if (!isHex32(facts.invoice_hash)) {
    throw invalid("facts.invoice_hash must be 64 lowercase hex characters: use hashInvoice(text)");
  }
  if (facts.invoice_hash !== hashInvoice(text)) {
    throw invalid(
      "facts.invoice_hash must equal hashInvoice(text), the hash of the exact text the model is shown (ICR-3b)",
    );
  }
  if (typeof facts.amount !== "string") {
    throw invalid("facts.amount must be a decimal string in the token's smallest units");
  }
  const purposeHash = facts.purpose_hash ?? null;
  if (purposeHash !== null && !isHex32(purposeHash)) {
    throw invalid("facts.purpose_hash must be 64 lowercase hex characters or null");
  }
  const rawPoRef = facts.po_ref ?? null;
  if (rawPoRef !== null && typeof rawPoRef !== "string") {
    throw invalid("facts.po_ref must be text or null");
  }
  const poRef = rawPoRef === "" ? null : rawPoRef;
  if (poRef !== null && !text.includes(poRef)) {
    throw invalid(
      "facts.po_ref must be null or copied verbatim from the invoice text, with no trimming, case change or normalisation (ICR-3c)",
    );
  }
  return {
    text,
    ref: checkRef(invoice.ref),
    facts: {
      invoice_hash: facts.invoice_hash,
      amount: facts.amount,
      po_ref: poRef,
      purpose_hash: purposeHash,
      payee_hint: checkPayeeHint(facts.payee_hint),
    },
  };
}

interface SpendInput {
  mandateId: number;
  amount: string;
  invoiceHash: Hex32;
  ref: string;
  proposal: ModelProposal | null;
  evidence: AttestationEvidence | null;
  skipPreflight: boolean;
}

function isU128Decimal(value: string): boolean {
  return DECIMAL_RE.test(value) && BigInt(value) <= U128_MAX;
}

function spendInput(input: unknown): SpendInput {
  if (!isRecord(input))
    throw invalid("requestSpend() takes { mandateId, amount, invoiceHash, ref }");
  const { mandateId, amount, invoiceHash } = input;
  if (typeof mandateId !== "number" || !Number.isSafeInteger(mandateId) || mandateId < 0) {
    throw invalid("mandateId must be a non-negative integer");
  }
  if (typeof amount !== "string") {
    throw invalid("amount must be a decimal string in the token's smallest units");
  }
  if (!isHex32(invoiceHash)) {
    throw invalid("invoiceHash must be 64 lowercase hex characters: use hashInvoice(text)");
  }
  const ref = checkRef(input.ref);
  const skipPreflight = input.skipPreflight ?? false;
  if (typeof skipPreflight !== "boolean") throw invalid("skipPreflight must be a boolean");
  // Raw mode skips the code rules, but the contract must still be able to read the amount, so that its
  // answer is a refusal code and not a deserialisation failure.
  if (skipPreflight && !isU128Decimal(amount)) {
    throw invalid("in raw mode the amount must still be a u128 decimal string");
  }
  const evidence = input.evidence ?? null;
  if (evidence !== null && !isRecord(evidence)) throw invalid("evidence must be an object or null");
  const rawProposal = input.proposal ?? null;
  let proposal: ModelProposal | null = null;
  if (rawProposal !== null) {
    try {
      proposal = parseModelProposal(rawProposal);
    } catch (error) {
      throw invalid(`proposal is not a model proposal: ${messageOf(error)}`);
    }
  }
  return {
    mandateId,
    amount,
    invoiceHash,
    ref,
    proposal,
    evidence: evidence as AttestationEvidence | null,
    skipPreflight,
  };
}

// ---------- helpers ----------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/**
 * The part of A8 that needs no invoice text: the strict shape of `request_inputs`, its model, both of its
 * invoice hashes against the ledger's, and the system prompt in the allow-list. `requestSpend` has only the
 * hash, so it holds caller evidence to this before writing it.
 */
function requestInputsProblemWithoutText(
  evidence: AttestationEvidence,
  context: NonceContext,
  prompts: readonly KnownSystemPrompt[],
): string | null {
  const shape = proposalRequestInputsProblem(evidence.request_inputs);
  if (shape !== null) return `A8 would fail: ${shape}`;
  const inputs = evidence.request_inputs as ProposalRequestInputs;
  if (inputs.model !== evidence.model)
    return "A8 would fail: request_inputs.model is not the evidence model";
  if (
    inputs.invoice_text_sha256 !== context.invoice_hash ||
    inputs.facts?.invoice_hash !== context.invoice_hash
  ) {
    return "A8 would fail: request_inputs does not carry this invoice hash";
  }
  const promptHash = sha256Hex(inputs.system_prompt);
  if (!prompts.some((p) => p.sha256 === promptHash)) {
    return "A8 would fail: the system prompt is not in the allow-list";
  }
  return null;
}

const RAW_MODE_DETAIL = "preflight skipped by caller";

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
  /** The head the decision (and its nonce) was made against. */
  expected: { seq: number; prev_link: Hex32 };
  now: Date;
  skipPreflight: boolean;
}

/** What one `spend` call came to, read from the sender's answer (task-13 carries C2). */
type SettledStatus = "paid" | "burned" | "held";

function isSettled(status: SpendResult["status"]): status is SettledStatus {
  return status === "paid" || status === "burned" || status === "held";
}

type SpendRead =
  | {
      kind: "ok";
      result: { spend_id: number; status: SettledStatus };
      txHash: string | null;
      /** Set when the answer was DuplicateRef/DuplicateInvoice and the spend was found by ref (C2 d). */
      byRef: { code: string; answeredTxHash: string | null } | null;
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

type OutcomeFields = Pick<SpendOutcome, "status" | "spendId" | "code" | "txHash">;

/**
 * The Probarion client for one vault.
 *
 * With no keys and `model: null` the instance is read-only: `mandates.*`, `spends.get`, `anchors.latest`
 * and `checkSpend` work (Task 14 adds `snapshot()` and `verify()`); `process` and `requestSpend` throw
 * `ConfigError` before reading or writing anything.
 *
 * Serialization: `process` and `requestSpend` run in one critical section per instance (a `Mutex`), and the
 * ledger store serializes appends across processes (Task 12's file lock).
 *
 * LEDGER_FORK_RISK: the window read chain → decide → append decision → spend → append payment is NOT
 * serialized across processes or instances. Two writers on one vault can both decide from the same chain
 * state (the contract still refuses the second spend of an invoice or ref), and two writers on one ledger
 * file make a cycle find the head moved: it then throws `LedgerError` before it sends anything. Two writers
 * with two ledger files fork the vault's history; only one of them can be anchored. Plan 05's MCP guard
 * compares `anchors.latest()` with the local ledger; this class does not try to solve it.
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
        if (typeof rule.check !== "function")
          throw new ConfigError(`custom rule ${id} has no check()`);
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
   * substring of `text`, otherwise `ProbarionError` `InvalidInput` is thrown before any write (ICR-6).
   */
  process(invoice: { text: string; facts: InvoiceFacts; ref: string }): Promise<SpendOutcome> {
    return this.lock.run(async () => {
      const input = processInput(invoice);
      const keys = this.requireKeys();
      const now = this.now();
      const ctx = await this.loadContext();
      this.assertLedgerKey(ctx.config, keys);
      const expected = nextBodyFields(await this.ledger.head());
      // The nonce mandate: the decision entry records it and the policy refuses any decision that leaves it
      // (invoice.po_mismatch), so the nonce recomputed from the entry always matches.
      const candidate = purposeMatch(ctx.mandates, input.facts.purpose_hash, now, keys.agentPk);
      const model = await this.modelStep(input, candidate, expected);
      const decision = decide({
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
   * named mandate only. No recipient parameter exists. Caller evidence is written only if it passes A1–A7 and
   * the text-free part of A8 at this ledger position; otherwise it is dropped and the decision is rules-only.
   *
   * `skipPreflight: true` (Canary raw mode only) writes a decision entry (verdict allow, rule
   * `custom.raw_mode`), skips the code rules and `check_spend`, and always sends `spend`: a contract panic
   * comes back as `refused_by_contract` with the bare code and the failed transaction's hash.
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
      const expected = nextBodyFields(await this.ledger.head());
      const mandate = ctx.mandates.find((m) => m.id === s.mandateId) ?? null;

      let evidence = s.evidence;
      let attestationOk: boolean | null = null;
      if (evidence !== null) {
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
        const raw: Decision = {
          verdict: "allow",
          mandate_id: s.mandateId,
          amount: s.amount,
          rules: [{ id: "custom.raw_mode", outcome: "pass", detail: RAW_MODE_DETAIL }],
          decided_by: "rules-only",
        };
        return {
          ...(await this.execute({ ...base, decision: raw, skipPreflight: true })),
          modelUsage: null,
        };
      }
      const decision = decide({
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
    this.deps.logger?.warn(message, { vault: this.vaultId });
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
    if (this.proposer === null || candidate === null) {
      return { proposal: null, evidence: null, attestationOk: null, modelUsage: null };
    }
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
    if (text === null)
      return requestInputsProblemWithoutText(evidence, context, this.systemPrompts);
    const a8 = checkRequestBinding(evidence, text, context, { systemPrompts: this.systemPrompts });
    return a8.pass ? null : `A8 failed: ${a8.detail}`;
  }

  private async execute(c: Cycle): Promise<Omit<SpendOutcome, "modelUsage">> {
    const d = c.decision;
    if (d.verdict !== "refuse" && d.mandate_id !== c.entryMandateId) {
      throw new ProbarionError(
        `internal: decision mandate ${String(d.mandate_id)} differs from the nonce mandate ${String(c.entryMandateId)}`,
        "Internal",
      );
    }
    const head = nextBodyFields(await this.ledger.head());
    if (head.seq !== c.expected.seq || head.prev_link !== c.expected.prev_link) {
      throw new LedgerError(
        `the ledger moved past seq ${c.expected.seq} while deciding: another writer appended to it (LEDGER_FORK_RISK); nothing was written or sent`,
      );
    }
    const decisionEntry = await this.ledger.append(
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
    );
    if (
      decisionEntry.body.seq !== c.expected.seq ||
      decisionEntry.body.prev_link !== c.expected.prev_link
    ) {
      throw new LedgerError(
        `another writer appended to the ledger while this decision was written (it landed at seq ${decisionEntry.body.seq}, not ${c.expected.seq}); no spend was sent (LEDGER_FORK_RISK)`,
      );
    }
    const decisionHash = decisionEntry.body_hash;
    const finish = async (fields: OutcomeFields, last: LedgerEntry | null) => ({
      ...fields,
      ledgerSeq: (last ?? decisionEntry).body.seq,
      decisionHash,
      anchorTxHash: await this.anchorTail(),
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
        return finish(
          { status: "refused_by_contract", spendId: null, code: verdict.code, txHash: null },
          entry,
        );
      }
      if (d.verdict === "hold" && !verdict.would_hold) {
        // The code holds but the contract would pay at once: hold off-chain, send nothing.
        const code = firstRule(d.rules, "hold");
        return finish({ status: "held", spendId: null, code, txHash: null }, null);
      }
    }

    const read = await this.sendSpend(request);
    switch (read.kind) {
      case "ok": {
        const { result, byRef } = read;
        const payee = c.mandate?.payee;
        // A spend found by ref after a duplicate answer was paid by an earlier transaction whose hash is unknown.
        const settlement =
          result.status === "burned" && payee?.type === "intents"
            ? {
                chain: payee.chain,
                tx_hash: null,
                burn_tx_hash: byRef === null ? read.txHash : null,
              }
            : null;
        const entry = await payment(
          [],
          {
            code: byRef?.code ?? null,
            tx_hash: byRef === null ? read.txHash : byRef.answeredTxHash,
            spend_id: result.spend_id,
            status: result.status,
          },
          settlement,
        );
        const txHash = byRef === null ? read.txHash : null;
        return finish(
          { status: result.status, spendId: result.spend_id, code: null, txHash },
          entry,
        );
      }
      case "unknown": {
        this.warn(
          `spend ${read.txHash ?? "(no tx hash)"} for ref ${c.ref} has an unknown outcome (${read.why}): it may have paid. Never send it again, least of all under a fresh ref; resolve it with resolveSpend(txHash) or by looking the spend up by ref. A transaction that never landed stays unknown until its block-hash window expires (about 1 day).`,
        );
        const entry = await payment([], {
          code: read.contractCode,
          tx_hash: read.txHash,
          spend_id: read.spendId,
          status: "unknown",
        });
        return finish(
          { status: "unconfirmed", spendId: read.spendId, code: read.code, txHash: read.txHash },
          entry,
        );
      }
      case "refused": {
        const entry = await payment([refusal(read.detail)], {
          code: read.code,
          tx_hash: read.txHash,
          spend_id: null,
          status: "refused",
        });
        return finish(
          { status: "refused_by_contract", spendId: null, code: read.code, txHash: read.txHash },
          entry,
        );
      }
      case "failed": {
        this.warn(`spend for ref ${c.ref} did not pay: ${read.detail}`);
        const entry = await payment(read.released ? [] : [refusal(read.detail)], {
          code: read.entryCode,
          tx_hash: read.entryTxHash,
          spend_id: read.spendId,
          status: read.entryStatus,
        });
        return finish(
          { status: "failed", spendId: read.spendId, code: read.code, txHash: read.txHash },
          entry,
        );
      }
    }
  }

  /**
   * Sends `spend` once and reads the answer (C2): `ok` first, then `unconfirmed`, then the definite failures.
   * It never sends again: an unknown outcome stays unknown, and a duplicate answer is looked up by ref.
   */
  private async sendSpend(request: SpendRequest): Promise<SpendRead> {
    let sent: SpendTxResult;
    try {
      sent = await this.vault.spend(request);
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
      const why = `the answer says ok without a paid, burned or held status (${String(result?.status)})`;
      return {
        kind: "unknown",
        txHash: tx.txHash,
        spendId: result?.spend_id ?? null,
        code: "unreadable_value",
        contractCode: null,
        why,
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
    if (tx.code === "DuplicateRef" || tx.code === "DuplicateInvoice")
      return this.lookUpByRef(request, tx, tx.code);
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
   * refused a used ref and a live invoice, so the spend that holds them is either this decision's own (the
   * InvalidNonce re-sign corner: the first copy landed, its answer was lost) or another writer's.
   */
  private async lookUpByRef(
    request: SpendRequest,
    tx: TxOutcome,
    code: string,
  ): Promise<SpendRead> {
    let spends: SpendView[];
    try {
      spends = await this.vault.listAllSpends();
    } catch (error) {
      return {
        kind: "unknown",
        txHash: tx.txHash,
        spendId: null,
        code,
        contractCode: code,
        why: `spend answered PROBARION:${code} and the spend could not be looked up by ref (${messageOf(error)}); it may be this decision's own spend`,
      };
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
      return {
        kind: "refused",
        txHash: tx.txHash,
        code,
        detail: `spend panicked with PROBARION:${code}`,
      };
    }
    if (isSettled(own.status)) {
      return {
        kind: "ok",
        result: { spend_id: own.id, status: own.status },
        txHash: null,
        byRef: { code, answeredTxHash: tx.txHash },
      };
    }
    switch (own.status) {
      case "pending":
        return {
          kind: "unknown",
          txHash: tx.txHash,
          spendId: own.id,
          code: "pending",
          contractCode: code,
          why: `spend ${own.id} of this decision is still pending`,
        };
      default:
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
        `the payment entry could not be written (${messageOf(error)}); the outcome stands: spend ${String(c?.spend_id ?? "-")}, status ${String(c?.status)}, tx ${String(c?.tx_hash ?? "-")}. The chain keeps the spend and its decision_hash.`,
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
        this.warn(
          `the vault's last anchor covers ${anchored.count} entries but this ledger holds ${entries.length}: it is not the anchored ledger (LEDGER_FORK_RISK)`,
        );
        return null;
      }
      if (anchored.count === entries.length) return null;
      let tx: TxOutcome;
      try {
        tx = await this.vault.anchor(anchored.seq + 1, last.link, entries.length);
      } catch (error) {
        if (!(error instanceof ContractError && error.vaultCode === "BadSeq")) throw error;
        anchored = await this.fetchLastAnchor();
        if (anchored.count >= entries.length) return null;
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

function refusal(detail: string): RuleResult {
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
