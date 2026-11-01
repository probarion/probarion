// TS mirrors of the contract ABI (interfaces §4.1, §5). JSON keys are exactly what the
// contract serialises: snake_case fields, `Payee` tagged by "type", enums in snake_case.
// Checked field by field against contracts/vault/src/types.rs and contracts/factory/src/lib.rs.

export type U128 = string; // decimal string, token smallest units
export type U64 = string; // decimal string, nanoseconds

export type Chain = "base" | "solana";

export type Payee =
  | { type: "near"; account_id: string }
  | { type: "intents"; chain: Chain; address: string; asset: string };

export type MandateStatus = "active" | "revoked" | "exhausted";

export interface MandateInput {
  payee: Payee;
  purpose_hash: string;
  max_per_payment: U128;
  max_total: U128;
  max_uses: number;
  expires_at_ns: U64;
  approval_above: U128;
  agent_pk: string;
  label: string;
}

export interface MandateView {
  id: number;
  payee: Payee;
  purpose_hash: string;
  max_per_payment: U128;
  max_total: U128;
  spent: U128;
  reserved: U128;
  max_uses: number;
  uses: number;
  expires_at_ns: U64;
  approval_above: U128;
  agent_pk: string;
  label: string;
  status: MandateStatus; // derived from state by the contract (v2)
  created_at_ns: U64;
}
// v2: ids start at 1; `uses` counts live spends (a released spend gives its use back).

export interface SpendRequest {
  mandate_id: number;
  amount: U128;
  invoice_hash: string;
  ref: string;
  decision_hash: string;
}

export type SpendStatus =
  | "held"
  | "pending"
  | "paid"
  | "burned"
  | "failed"
  | "rejected"
  | "expired";

export interface SpendView {
  id: number;
  mandate_id: number;
  amount: U128;
  invoice_hash: string;
  ref: string;
  decision_hash: string;
  agent_pk: string;
  destination: Payee;
  status: SpendStatus;
  created_at_ns: U64;
  held_until_ns: U64 | null;
  memo: string | null;
}

export interface SpendResult {
  spend_id: number;
  status: SpendStatus;
}

/** Mirror of the Rust `Verdict` struct returned by `check_spend` (renamed in TS because `Verdict` is the ledger verdict below). `code` is bare, e.g. "NoMandate". */
export interface CheckSpendVerdict {
  ok: boolean;
  code: string | null;
  would_hold: boolean;
}

export interface AnchorView {
  seq: number;
  root: string;
  count: number;
  at_ns: U64;
  ledger_key: string; // signer pk at anchor time (supports set_ledger_key rotation)
}

export interface AgentView {
  public_key: string;
  label: string;
  added_at_ns: U64;
}

export interface VaultConfig {
  owner: string;
  approvers: string[];
  usdc: string;
  intents: string;
  allowed_assets: string[];
  daily_backstop: U128;
  held_ttl_ns: U64;
  frozen: boolean;
  factory: string | null;
  version: string;
  ledger_key: string | null;
}

/**
 * One registered vault build of the factory. Factory version ids are 1-based (R14): the contract
 * computes `index: i + 1`, so the first version added has `index` 1.
 */
export interface VersionView {
  index: number; // 1-based
  code_hash: string; // base58
  mode: string; // "global" | "embedded"
  notes: string;
  at_ns: U64;
}

export interface VaultRecord {
  account_id: string;
  owner: string;
  version: number; // 1-based factory version id the vault was created from
  created_at_ns: U64;
}

export interface FactoryConfig {
  owner: string;
  usdc: string;
  intents: string;
  allowed_assets: string[];
  min_deposit: U128;
  current_version: number | null; // 1-based: the number of versions registered, null when none
}

/** Panic codes of interfaces §4.3; the panic message is exactly `PROBARION:<Code>`. */
export const VAULT_ERROR_CODES = [
  "NoMandate",
  "MandateInactive",
  "MandateExpired",
  "NotMandateAgent",
  "ZeroAmount",
  "OverPerPayment",
  "UsesExhausted",
  "OverMandateTotal",
  "DuplicateInvoice",
  "DuplicateRef",
  "OverDailyBackstop",
  "Frozen",
  "NotAgent",
  "NotOwner",
  "NotApprover",
  "NotLedgerKey",
  "NotHeld",
  "HoldExpired",
  "HoldNotExpired",
  "BadSeq",
  "AssetNotAllowed",
  "InvalidInput",
  "InsufficientDeposit",
  "RequiresOneYocto",
] as const;
export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[number];

// ---------- Ledger (interfaces §6) ----------

export type Hex32 = string; // /^[0-9a-f]{64}$/
export type Verdict = "allow" | "hold" | "refuse";
export type LedgerEntryKind = "decision" | "payment" | "approval" | "anchor" | "note";
export type RuleId =
  | "mandate.none"
  | "mandate.inactive"
  | "mandate.expired"
  | "mandate.payee_mismatch"
  | "mandate.over_per_payment"
  | "mandate.over_total"
  | "mandate.uses_exhausted"
  | "mandate.agent_mismatch"
  | "invoice.duplicate"
  | "invoice.po_mismatch"
  | "invoice.amount_invalid"
  | "model.attestation_invalid"
  | "model.low_confidence"
  | "model.refused"
  | "model.unavailable"
  | "intents.balance_low"
  | "vault.frozen"
  | "vault.daily_backstop"
  | "contract.check_failed"
  | `custom.${string}`;

export interface RuleResult {
  id: RuleId;
  outcome: "pass" | "hold" | "refuse";
  detail: string;
}

export interface ModelProposal {
  action: "pay" | "hold" | "refuse";
  mandate_id: number | null;
  amount: string | null; // smallest units
  payee_hint: PayeeHint | null; // what the invoice claims; never used as destination
  reasoning: string; // ≤ 2000 chars
  confidence: number; // 0..1
}
export interface PayeeHint {
  near_account?: string;
  chain?: "base" | "solana";
  address?: string;
  name?: string;
}

/** The four invoice facts the model is shown (interfaces §7, ICR-3). The code-extracted payee hint is not shown. */
export interface ProposalRequestFacts {
  invoice_hash: Hex32;
  amount: string;
  po_ref: string | null;
  purpose_hash: Hex32 | null;
}

/** What the model is shown of one mandate (ICR-3); `remaining` is max_total - spent - reserved. */
export interface ProposalRequestMandate {
  id: number;
  label: string;
  payee: Payee;
  purpose_hash: string;
  max_per_payment: U128;
  remaining: U128;
  expires_at_ns: U64;
  status: MandateStatus;
}

/**
 * ICR-3: every input of the chat request except the invoice text, which is never stored. The auditor
 * check A8 rebuilds the request from these and the invoice text (see `buildProposalRequest`).
 */
export interface ProposalRequestInputs {
  template: "probarion-proposal/v1";
  model: string; // equals AttestationEvidence.model
  system_prompt: string; // the exact system message: PROPOSAL_SYSTEM_PROMPT or a persona
  facts: ProposalRequestFacts | null;
  mandates: ProposalRequestMandate[]; // in the order shown to the model
  invoice_text_sha256: Hex32; // sha256(utf8(invoice text))
}

export interface AttestationEvidence {
  provider: "near-ai-cloud";
  model: string;
  chat_id: string;
  nonce: Hex32;
  /** sha256 of the exact chat request body (UTF-8 bytes of `buildProposalRequest`'s output); the auditor check A8 recomputes it. */
  request_sha256: Hex32;
  /**
   * ICR-3: the inputs the request was built from, without the invoice text. The SDK writes it on every
   * attested decision. It is optional in the type only so that evidence recorded before ICR-3 (the
   * Task 6 fixtures) still parses; A8 fails closed when it is absent.
   */
  request_inputs?: ProposalRequestInputs;
  response_sha256: Hex32;
  /**
   * ICR-2: the exact UTF-8 text of the chat-completion HTTP response body as received; sha256(utf8(.)) === response_sha256 (A7).
   * It may quote invoice details. ICR-3: at most 64 KiB; the SDK treats a larger response as model_unavailable.
   */
  response_body: string;
  /** ICR-3: stored normalized at capture, v in {27, 28} and low-s. */
  signature: { text: string; signature: string; signing_address: string; signing_algo: "ecdsa" };
  report: {
    signing_address: string;
    signing_algo: "ecdsa";
    request_nonce: Hex32;
    report_data: string /* 128 hex, EXTRACTED from intel_quote (see §7) */;
    intel_quote: string;
    nvidia_payload: string | null;
    event_log: unknown | null;
  } | null; // exactly one signer-matched attestation candidate, else null
  fetched_at: string; // ISO-8601
}

export interface LedgerEntryBody {
  v: 1;
  vault: string;
  seq: number; // 0-based, contiguous
  prev_link: Hex32; // "0".repeat(64) when seq = 0
  kind: LedgerEntryKind;
  at: string; // ISO-8601 UTC
  request_id: string; // also in logs/Sentry
  mandate_id: number | null;
  invoice_hash: Hex32 | null;
  amount: string | null;
  proposal: ModelProposal | null;
  evidence: AttestationEvidence | null;
  rules: RuleResult[];
  verdict: Verdict | null; // null for non-decision kinds
  decided_by: "model+rules" | "rules-only" | null;
  contract: {
    code: string | null;
    tx_hash: string | null;
    spend_id: number | null;
    status: string | null;
  } | null;
  settlement: {
    chain: "base" | "solana";
    tx_hash: string | null;
    burn_tx_hash: string | null;
  } | null;
  refs: { decision_body_hash?: Hex32; anchor_seq?: number } | null; // payment/approval entries point back to their decision
}

export interface LedgerEntry {
  body: LedgerEntryBody;
  body_hash: Hex32; // sha256(utf8(canonicalize(body)))
  sig: string; // "ed25519:<base58 64-byte signature>" over the 32 raw bytes of body_hash
  signer: string; // "ed25519:<base58 32-byte public key>" = vault's ledger FC key
  link: Hex32; // sha256(bytes(prev_link) || bytes(body_hash) || raw 64-byte sig)
}

// ---------- Policy (interfaces §8) ----------

export interface InvoiceFacts {
  invoice_hash: Hex32;
  amount: string;
  po_ref: string | null;
  purpose_hash: Hex32 | null;
  payee_hint: PayeeHint | null;
}

export interface DecisionInput {
  vault: string;
  agentPk: string;
  now: Date;
  invoice: InvoiceFacts;
  proposal: ModelProposal | null; // null → rules-only
  attestationOk: boolean | null; // null when no model was used; false with proposal null = model attempted but unavailable
  mandates: MandateView[];
  paidInvoiceHashes: ReadonlySet<string>;
  usedRefs: ReadonlySet<string>;
  intentsBalance: bigint | null; // POA balance of the vault in intents.near for the mandate's asset
  frozen: boolean;
  confidenceFloor: number; // default 0.7
  customRules?: CustomRule[];
  ref: string; // current spend ref; a used ref -> refuse invoice.duplicate
  daily: { backstop: string; spent_today: string } | null; // mirror of the contract's UTC-day backstop
}

export interface Decision {
  verdict: Verdict;
  mandate_id: number | null;
  amount: string | null;
  rules: RuleResult[];
  decided_by: "model+rules" | "rules-only";
}

export interface CustomRule {
  id: `custom.${string}`;
  check(input: DecisionInput, chosen: MandateView | null): RuleResult;
}

// ---------- Attestation (interfaces §7) ----------

/** A1 to A7 come from `checkAttestation`; A8 (request binding, ICR-3) from `checkRequestBinding`. */
export type AttestationCheckId = "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7" | "A8";
export type AttestationBinding = "address" | "tls" | "none";
export interface AttestationCheck {
  id: AttestationCheckId;
  pass: boolean;
  detail: string;
}
export interface AttestationResult {
  ok: boolean;
  binding: AttestationBinding;
  /**
   * Always false from the offline checks: A1..A7 prove internal consistency only. It is a boolean
   * because the SDK's online path may set it true, after O1 verifies the DCAP quote and the measurement pin.
   */
  quote_verified: boolean;
  checks: AttestationCheck[]; // always A1..A7, in order (A8 is a separate check)
}

// ---------- Verifier (interfaces §10) ----------

export type CheckId = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i";
export interface CheckResult {
  id: CheckId;
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  firstBrokenSeq?: number;
  /** Check c only: the last seq of the range it cannot prove (`firstBrokenSeq` is the first). Information only; absent means one entry. */
  lastUnprovenSeq?: number;
}
export interface VerifyReport {
  vault: string;
  network: "mainnet" | "testnet";
  ok: boolean;
  checks: CheckResult[];
  entries: number;
  anchors: number;
  generated_at: string;
}

export interface AccessKeyInfo {
  public_key: string;
  permission:
    | "FullAccess"
    | { receiver_id: string; method_names: string[]; allowance: string | null };
}
export interface Snapshot {
  v: 1;
  vault: string;
  network: "mainnet" | "testnet";
  taken_at: string;
  ledger: LedgerEntry[];
  chain: {
    access_keys: AccessKeyInfo[];
    code_hash: string;
    config: VaultConfig;
    anchors: AnchorView[];
    spends: SpendView[];
    intents_public_keys: string[];
    intents_predecessor_auth: boolean;
    factory_version: number | null; // 1-based, as returned by the factory's `vault_version`
    factory_versions: VersionView[];
    burns: {
      spend_id: number;
      tx_hash: string;
      memo: string;
      intents_owner: string;
      amount: string;
      status: "ok" | "missing";
    }[]; // POA ft_burn (owner_id = intents.near, memo) matched with intents.near mt_burn (owner_id = vault) in the same tx
  };
  expected_code_hashes: string[]; // advisory (ICR-5): check f derives its own trusted set and FAILS if this lists a hash outside it
  pre_ledger_decision_hashes: Hex32[]; // Day-4 v0 spends from before the ledger (ICR-4b: each hash exempts one spend, created before the first anchor)
}
