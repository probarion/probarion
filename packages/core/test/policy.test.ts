import { describe, expect, it } from "vitest";
import { sha256Bytes, sha256Hex } from "../src/hash.js";
import { utf8 } from "../src/hex.js";
import { generateKeyPair } from "../src/keys.js";
import {
  DEFAULT_CONFIDENCE_FLOOR,
  decide,
  describePayee,
  isPositiveAmount,
  payeeHintContradiction,
  purposeMatch,
} from "../src/policy.js";
import type {
  Decision,
  DecisionInput,
  MandateView,
  PayeeHint,
  RuleId,
  RuleResult,
  Verdict,
} from "../src/types.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const NOW_NS = BigInt(NOW.getTime()) * 1_000_000n;
const MS_NS = 1_000_000n;
const U128_MAX = ((1n << 128n) - 1n).toString();
const AGENT = generateKeyPair(sha256Bytes(utf8("probarion/test-fixture/policy-agent"))).publicKey;
const OTHER_AGENT = generateKeyPair(
  sha256Bytes(utf8("probarion/test-fixture/policy-other")),
).publicKey;
const P1 = sha256Hex("PO-1001");
const P2 = sha256Hex("PO-2002");
const BASE_ADDRESS = "0xAbCdEf0000000000000000000000000000000001";

function mandate(overrides: Partial<MandateView> = {}): MandateView {
  return {
    id: 1,
    payee: { type: "near", account_id: "vendor.testnet" },
    purpose_hash: P1,
    max_per_payment: "100000000",
    max_total: "1000000000",
    spent: "0",
    reserved: "0",
    max_uses: 10,
    uses: 0,
    expires_at_ns: "1798761600000000000", // 2027-01-01T00:00:00Z
    approval_above: "100000000",
    agent_pk: AGENT,
    label: "Design retainer",
    status: "active",
    created_at_ns: "1762300000000000000",
    ...overrides,
  };
}

const BASE_MANDATE = mandate({
  id: 2,
  payee: {
    type: "intents",
    chain: "base",
    address: BASE_ADDRESS,
    asset: "base-usdc.probarion.testnet",
  },
  purpose_hash: P2,
  label: "Base contractor",
});

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    vault: "acme.vaults.probarion.testnet",
    agentPk: AGENT,
    now: NOW,
    invoice: {
      invoice_hash: sha256Hex("invoice-1"),
      amount: "25000000",
      po_ref: "PO-1001",
      purpose_hash: P1,
      payee_hint: { near_account: "vendor.testnet", name: "Vendor Ltd" },
    },
    proposal: {
      action: "pay",
      mandate_id: 1,
      amount: "25000000",
      payee_hint: { near_account: "vendor.testnet" },
      reasoning: "Invoice matches PO-1001.",
      confidence: 0.9,
    },
    attestationOk: true,
    mandates: [mandate(), BASE_MANDATE],
    paidInvoiceHashes: new Set<string>(),
    usedRefs: new Set<string>(),
    intentsBalance: 1_000_000_000n,
    frozen: false,
    confidenceFloor: DEFAULT_CONFIDENCE_FLOOR,
    ref: "INV-1",
    daily: { backstop: "500000000", spent_today: "0" },
    ...overrides,
  };
}

function baseInvoice(overrides: Partial<DecisionInput["invoice"]> = {}): DecisionInput["invoice"] {
  return { ...input().invoice, ...overrides };
}

function proposal(
  overrides: Partial<NonNullable<DecisionInput["proposal"]>> = {},
): DecisionInput["proposal"] {
  const p = input().proposal;
  if (p === null) throw new Error("fixture proposal missing");
  return { ...p, ...overrides };
}

function intentsInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return input({
    invoice: baseInvoice({
      purpose_hash: P2,
      po_ref: "PO-2002",
      payee_hint: { chain: "base", address: BASE_ADDRESS.toLowerCase() },
    }),
    proposal: proposal({ mandate_id: 2, payee_hint: { chain: "base", address: BASE_ADDRESS } }),
    ...overrides,
  });
}

/** No model: the mandate is chosen by `purposeMatch` alone. */
function rulesOnly(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return input({ proposal: null, attestationOk: null, ...overrides });
}

function rule(rules: RuleResult[], id: RuleId): RuleResult | undefined {
  return rules.find((r) => r.id === id);
}

interface Case {
  name: string;
  input: () => DecisionInput;
  verdict: Verdict;
  rule: [RuleId, RuleResult["outcome"]];
  /** Set when the case feeds a field the contract can never hold (a non-numeric string), so the oracle cannot model it. */
  skipOracle?: true;
}

const EXPIRED = "1762344000000000000"; // 2025-11-05T12:00:00Z, before NOW

const cases: Case[] = [
  {
    name: "clean invoice is allowed",
    input: () => input(),
    verdict: "allow",
    rule: ["mandate.payee_mismatch", "pass"],
  },
  {
    name: "frozen vault",
    input: () => input({ frozen: true }),
    verdict: "refuse",
    rule: ["vault.frozen", "refuse"],
  },
  {
    name: "zero amount",
    input: () => input({ invoice: baseInvoice({ amount: "0" }) }),
    verdict: "refuse",
    rule: ["invoice.amount_invalid", "refuse"],
  },
  {
    name: "human decimal amount",
    input: () => input({ invoice: baseInvoice({ amount: "25.00" }) }),
    verdict: "refuse",
    rule: ["invoice.amount_invalid", "refuse"],
  },
  {
    name: "leading zero amount",
    input: () => input({ invoice: baseInvoice({ amount: "025" }) }),
    verdict: "refuse",
    rule: ["invoice.amount_invalid", "refuse"],
  },
  {
    name: "negative amount",
    input: () => input({ invoice: baseInvoice({ amount: "-5" }) }),
    verdict: "refuse",
    rule: ["invoice.amount_invalid", "refuse"],
  },
  {
    name: "model amount differs from invoice",
    input: () => input({ proposal: proposal({ amount: "99000000" }) }),
    verdict: "refuse",
    rule: ["invoice.amount_invalid", "refuse"],
  },
  {
    name: "invoice already paid",
    input: () => input({ paidInvoiceHashes: new Set([sha256Hex("invoice-1")]) }),
    verdict: "refuse",
    rule: ["invoice.duplicate", "refuse"],
  },
  {
    name: "ref already used",
    input: () => input({ usedRefs: new Set(["INV-1"]) }),
    verdict: "refuse",
    rule: ["invoice.duplicate", "refuse"],
  },
  {
    name: "ref reused for a different invoice",
    input: () =>
      input({
        invoice: baseInvoice({ invoice_hash: sha256Hex("invoice-2") }),
        usedRefs: new Set(["INV-1"]),
      }),
    verdict: "refuse",
    rule: ["invoice.duplicate", "refuse"],
  },
  {
    name: "split payment: model proposes part of the invoice",
    input: () => input({ proposal: proposal({ amount: "12500000" }) }),
    verdict: "refuse",
    rule: ["invoice.amount_invalid", "refuse"],
  },
  {
    name: "daily backstop exceeded",
    input: () => input({ daily: { backstop: "100000000", spent_today: "90000000" } }),
    verdict: "refuse",
    rule: ["vault.daily_backstop", "refuse"],
  },
  {
    name: "daily backstop exactly reached (> not >=)",
    input: () => input({ daily: { backstop: "100000000", spent_today: "75000000" } }),
    verdict: "allow",
    rule: ["vault.daily_backstop", "pass"],
  },
  {
    name: "daily data absent passes",
    input: () => input({ daily: null }),
    verdict: "allow",
    rule: ["vault.daily_backstop", "pass"],
  },
  // purposeMatch skips mandates the contract refuses outright (revoked, expired, no uses or no room
  // left) and takes the lowest live id; if none is live it falls back to the lowest id.
  {
    name: "rules-only: an expired id-1 mandate does not shadow a live id-2 one",
    input: () =>
      rulesOnly({ mandates: [mandate({ id: 1, expires_at_ns: EXPIRED }), mandate({ id: 2 })] }),
    verdict: "allow",
    rule: ["mandate.expired", "pass"],
  },
  {
    name: "rules-only: a revoked id-1 mandate does not shadow a live id-2 one",
    input: () =>
      rulesOnly({ mandates: [mandate({ id: 1, status: "revoked" }), mandate({ id: 2 })] }),
    verdict: "allow",
    rule: ["mandate.inactive", "pass"],
  },
  {
    name: "rules-only: an id-1 mandate out of uses does not shadow a live id-2 one",
    input: () =>
      rulesOnly({
        mandates: [mandate({ id: 1, uses: 10, status: "exhausted" }), mandate({ id: 2 })],
      }),
    verdict: "allow",
    rule: ["mandate.uses_exhausted", "pass"],
  },
  {
    name: "rules-only: an id-1 mandate out of total does not shadow a live id-2 one",
    input: () =>
      rulesOnly({
        mandates: [
          mandate({ id: 1, spent: "1000000000", status: "exhausted" }),
          mandate({ id: 2 }),
        ],
      }),
    verdict: "allow",
    rule: ["mandate.over_total", "pass"],
  },
  {
    name: "rules-only: every purpose match is dead, the lowest id explains the refusal",
    input: () =>
      rulesOnly({
        mandates: [
          mandate({ id: 2, status: "revoked" }),
          mandate({ id: 1, expires_at_ns: EXPIRED }),
        ],
      }),
    verdict: "refuse",
    rule: ["mandate.expired", "refuse"],
  },
  {
    name: "model proposes unknown mandate",
    input: () => input({ proposal: proposal({ mandate_id: 99 }) }),
    verdict: "refuse",
    rule: ["mandate.none", "refuse"],
  },
  {
    name: "rules-only with unmatched purpose",
    input: () =>
      input({
        proposal: null,
        attestationOk: null,
        invoice: baseInvoice({ purpose_hash: sha256Hex("unknown PO") }),
      }),
    verdict: "refuse",
    rule: ["mandate.none", "refuse"],
  },
  {
    name: "revoked mandate",
    input: () => input({ mandates: [mandate({ status: "revoked" })] }),
    verdict: "refuse",
    rule: ["mandate.inactive", "refuse"],
  },
  // checks.rs:34 refuses only `revoked` as MandateInactive. A mandate whose status is `exhausted`
  // (types.rs:195-203: uses >= max_uses or spent >= max_total) is refused by the contract as
  // UsesExhausted / OverMandateTotal, so decide() reports those codes (brief: mandate.inactive).
  {
    name: "exhausted by uses is refused as uses_exhausted",
    input: () => input({ mandates: [mandate({ uses: 10, status: "exhausted" })] }),
    verdict: "refuse",
    rule: ["mandate.uses_exhausted", "refuse"],
  },
  {
    name: "exhausted by total is refused as over_total",
    input: () => input({ mandates: [mandate({ spent: "1000000000", status: "exhausted" })] }),
    verdict: "refuse",
    rule: ["mandate.over_total", "refuse"],
  },
  {
    name: "expired mandate",
    input: () => input({ mandates: [mandate({ expires_at_ns: EXPIRED })] }),
    verdict: "refuse",
    rule: ["mandate.expired", "refuse"],
  },
  {
    name: "mandate expires at this very instant (now >= expires)",
    input: () => input({ mandates: [mandate({ expires_at_ns: NOW_NS.toString() })] }),
    verdict: "refuse",
    rule: ["mandate.expired", "refuse"],
  },
  {
    name: "mandate expires one millisecond from now",
    input: () => input({ mandates: [mandate({ expires_at_ns: (NOW_NS + MS_NS).toString() })] }),
    verdict: "allow",
    rule: ["mandate.expired", "pass"],
  },
  {
    name: "expiry comes from expires_at_ns even when the status still says active",
    input: () => input({ mandates: [mandate({ status: "active", expires_at_ns: EXPIRED })] }),
    verdict: "refuse",
    rule: ["mandate.expired", "refuse"],
  },
  {
    name: "unreadable expiry fails closed",
    input: () => input({ mandates: [mandate({ expires_at_ns: "soon" })] }),
    verdict: "refuse",
    rule: ["mandate.expired", "refuse"],
    skipOracle: true,
  },
  {
    name: "mandate bound to another agent",
    input: () => input({ agentPk: OTHER_AGENT }),
    verdict: "refuse",
    rule: ["mandate.agent_mismatch", "refuse"],
  },
  {
    name: "invoice without purpose",
    input: () => input({ invoice: baseInvoice({ purpose_hash: null }) }),
    verdict: "refuse",
    rule: ["invoice.po_mismatch", "refuse"],
  },
  {
    name: "invoice purpose differs from proposed mandate",
    input: () => input({ invoice: baseInvoice({ purpose_hash: P2 }) }),
    verdict: "refuse",
    rule: ["invoice.po_mismatch", "refuse"],
  },
  {
    name: "proposal picks a second mandate with the same purpose",
    input: () =>
      input({ mandates: [mandate(), mandate({ id: 3 })], proposal: proposal({ mandate_id: 3 }) }),
    verdict: "refuse",
    rule: ["invoice.po_mismatch", "refuse"],
  },
  {
    name: "invoice asks for another NEAR account",
    input: () =>
      input({ invoice: baseInvoice({ payee_hint: { near_account: "attacker.testnet" } }) }),
    verdict: "refuse",
    rule: ["mandate.payee_mismatch", "refuse"],
  },
  {
    name: "invoice asks a NEAR mandate to pay a Base address",
    input: () =>
      input({ invoice: baseInvoice({ payee_hint: { chain: "base", address: BASE_ADDRESS } }) }),
    verdict: "refuse",
    rule: ["mandate.payee_mismatch", "refuse"],
  },
  {
    name: "model hint contradicts the mandate",
    input: () =>
      input({ proposal: proposal({ payee_hint: { near_account: "attacker.testnet" } }) }),
    verdict: "refuse",
    rule: ["mandate.payee_mismatch", "refuse"],
  },
  {
    name: "payee name alone never contradicts",
    input: () => input({ invoice: baseInvoice({ payee_hint: { name: "Totally Different Ltd" } }) }),
    verdict: "allow",
    rule: ["mandate.payee_mismatch", "pass"],
  },
  {
    name: "Base address in another case matches",
    input: () => intentsInput(),
    verdict: "allow",
    rule: ["mandate.payee_mismatch", "pass"],
  },
  {
    name: "Base mandate, invoice asks for another address",
    input: () =>
      intentsInput({
        invoice: baseInvoice({
          purpose_hash: P2,
          payee_hint: { chain: "base", address: "0x000000000000000000000000000000000000dEaD" },
        }),
      }),
    verdict: "refuse",
    rule: ["mandate.payee_mismatch", "refuse"],
  },
  {
    name: "Base mandate, invoice asks for Solana",
    input: () =>
      intentsInput({
        invoice: baseInvoice({
          purpose_hash: P2,
          payee_hint: { chain: "solana", address: BASE_ADDRESS },
        }),
      }),
    verdict: "refuse",
    rule: ["mandate.payee_mismatch", "refuse"],
  },
  {
    name: "over per-payment cap",
    input: () =>
      input({
        invoice: baseInvoice({ amount: "100000001" }),
        proposal: proposal({ amount: "100000001" }),
      }),
    verdict: "refuse",
    rule: ["mandate.over_per_payment", "refuse"],
  },
  {
    name: "exactly the per-payment cap",
    input: () =>
      input({
        invoice: baseInvoice({ amount: "100000000" }),
        proposal: proposal({ amount: "100000000" }),
      }),
    verdict: "allow",
    rule: ["mandate.over_per_payment", "pass"],
  },
  {
    name: "uses exhausted",
    input: () => input({ mandates: [mandate({ uses: 10 })] }),
    verdict: "refuse",
    rule: ["mandate.uses_exhausted", "refuse"],
  },
  {
    name: "the last remaining use (uses >= max_uses)",
    input: () => input({ mandates: [mandate({ uses: 9 })] }),
    verdict: "allow",
    rule: ["mandate.uses_exhausted", "pass"],
  },
  {
    name: "over mandate total",
    input: () => input({ mandates: [mandate({ spent: "960000000", reserved: "20000000" })] }),
    verdict: "refuse",
    rule: ["mandate.over_total", "refuse"],
  },
  {
    name: "exactly the mandate total",
    input: () => input({ mandates: [mandate({ spent: "955000000", reserved: "20000000" })] }),
    verdict: "allow",
    rule: ["mandate.over_total", "pass"],
  },
  {
    name: "reserved counts against the total",
    input: () => input({ mandates: [mandate({ spent: "0", reserved: "980000000" })] }),
    verdict: "refuse",
    rule: ["mandate.over_total", "refuse"],
  },
  {
    name: "unreadable spent fails closed",
    input: () => input({ mandates: [mandate({ spent: "lots" })] }),
    verdict: "refuse",
    rule: ["mandate.over_total", "refuse"],
    skipOracle: true,
  },
  {
    name: "u128 sums saturate like the contract",
    input: () =>
      input({
        mandates: [
          mandate({
            max_per_payment: U128_MAX,
            max_total: U128_MAX,
            spent: U128_MAX,
            reserved: "1",
          }),
        ],
        daily: { backstop: U128_MAX, spent_today: U128_MAX },
      }),
    verdict: "allow",
    rule: ["mandate.over_total", "pass"],
  },
  {
    name: "Intents balance too low",
    input: () => intentsInput({ intentsBalance: 5_000_000n }),
    verdict: "hold",
    rule: ["intents.balance_low", "hold"],
  },
  {
    name: "Intents balance unknown",
    input: () => intentsInput({ intentsBalance: null }),
    verdict: "hold",
    rule: ["intents.balance_low", "hold"],
  },
  {
    name: "NEAR payee ignores the Intents balance",
    input: () => input({ intentsBalance: 0n }),
    verdict: "allow",
    rule: ["intents.balance_low", "pass"],
  },
  {
    name: "model refuses",
    input: () => input({ proposal: proposal({ action: "refuse" }) }),
    verdict: "refuse",
    rule: ["model.refused", "refuse"],
  },
  {
    name: "model holds",
    input: () => input({ proposal: proposal({ action: "hold" }) }),
    verdict: "hold",
    rule: ["model.refused", "hold"],
  },
  {
    name: "unknown model action fails closed",
    input: () => input({ proposal: proposal({ action: "approve" as unknown as "pay" }) }),
    verdict: "refuse",
    rule: ["model.refused", "refuse"],
  },
  {
    name: "low confidence",
    input: () => input({ proposal: proposal({ confidence: 0.5 }) }),
    verdict: "hold",
    rule: ["model.low_confidence", "hold"],
  },
  {
    name: "confidence exactly at the floor passes",
    input: () => input({ proposal: proposal({ confidence: 0.7 }) }),
    verdict: "allow",
    rule: ["model.low_confidence", "pass"],
  },
  {
    name: "NaN confidence holds",
    input: () => input({ proposal: proposal({ confidence: Number.NaN }) }),
    verdict: "hold",
    rule: ["model.low_confidence", "hold"],
  },
  {
    name: "custom floor",
    input: () => input({ proposal: proposal({ confidence: 0.5 }), confidenceFloor: 0.4 }),
    verdict: "allow",
    rule: ["model.low_confidence", "pass"],
  },
  {
    name: "invalid attestation falls back to rules-only",
    input: () =>
      input({ attestationOk: false, proposal: proposal({ action: "hold", confidence: 0.1 }) }),
    verdict: "allow",
    rule: ["model.attestation_invalid", "pass"],
  },
  {
    name: "proposal without attestation is ignored",
    input: () => input({ attestationOk: null }),
    verdict: "allow",
    rule: ["model.attestation_invalid", "pass"],
  },
  {
    name: "model unavailable is recorded",
    input: () => input({ proposal: null, attestationOk: false }),
    verdict: "allow",
    rule: ["model.unavailable", "pass"],
  },
  // validate.rs: is_hex64 (lowercase only, exactly 64) and is_ref (1-64 BYTES) -> InvalidInput (checks.rs:26).
  {
    name: "invoice_hash in uppercase hex",
    input: () =>
      input({ invoice: baseInvoice({ invoice_hash: sha256Hex("invoice-1").toUpperCase() }) }),
    verdict: "refuse",
    rule: ["contract.check_failed", "refuse"],
  },
  {
    name: "invoice_hash one character short",
    input: () =>
      input({ invoice: baseInvoice({ invoice_hash: sha256Hex("invoice-1").slice(0, 63) }) }),
    verdict: "refuse",
    rule: ["contract.check_failed", "refuse"],
  },
  {
    name: "empty ref",
    input: () => input({ ref: "" }),
    verdict: "refuse",
    rule: ["contract.check_failed", "refuse"],
  },
  {
    name: "ref of 65 bytes",
    input: () => input({ ref: "r".repeat(65) }),
    verdict: "refuse",
    rule: ["contract.check_failed", "refuse"],
  },
  {
    name: "ref of 33 two-byte characters (66 bytes)",
    input: () => input({ ref: "é".repeat(33) }),
    verdict: "refuse",
    rule: ["contract.check_failed", "refuse"],
  },
  {
    name: "ref of exactly 64 bytes",
    input: () => input({ ref: "r".repeat(64) }),
    verdict: "allow",
    rule: ["vault.frozen", "pass"],
  },
  {
    name: "ref of 32 two-byte characters (exactly 64 bytes)",
    input: () => input({ ref: "é".repeat(32) }),
    verdict: "allow",
    rule: ["vault.frozen", "pass"],
  },
];

// ---- Test-only oracle -------------------------------------------------------------------------
// A straight transcription of the contract's spend check, NOT part of the shipped code:
//   contracts/vault/src/checks.rs  Vault::evaluate (lines 17-71; check order = lines 23-65)
//   contracts/vault/src/validate.rs is_hex64 (9-14), is_ref (35-37)
//   contracts/vault/src/types.rs   Mandate::status (195-203): `revoked` <=> status "revoked"
// Vault state is rebuilt from the DecisionInput. The signer is the input's agentPk and is taken to
// be a registered agent (NotAgent, checks.rs:23): DecisionInput carries no agent registry. When
// `daily` is null the day total is unobservable, so the oracle does not check the backstop.

type ContractCode =
  | "InvalidInput"
  | "Frozen"
  | "NoMandate"
  | "MandateInactive"
  | "MandateExpired"
  | "NotMandateAgent"
  | "ZeroAmount"
  | "OverPerPayment"
  | "UsesExhausted"
  | "OverMandateTotal"
  | "DuplicateInvoice"
  | "DuplicateRef"
  | "OverDailyBackstop";
type Oracle = { ok: true; wouldHold: boolean } | { ok: false; code: ContractCode };
interface SpendRequest {
  mandateId: number;
  amount: bigint;
  invoiceHash: string;
  ref: string;
}

const MAX128 = (1n << 128n) - 1n;
function sat(a: bigint, b: bigint): bigint {
  // u128::saturating_add
  if (a + b > MAX128) return MAX128;
  return a + b;
}

function evaluate(i: DecisionInput, req: SpendRequest): Oracle {
  const refuse = (code: ContractCode): Oracle => ({ ok: false, code });
  const now = BigInt(i.now.getTime()) * MS_NS;
  const dayTotal = BigInt(i.daily?.spent_today ?? "0");
  const backstop = BigInt(i.daily?.backstop ?? U128_MAX);

  if (
    !/^[0-9a-f]{64}$/.test(req.invoiceHash) ||
    utf8(req.ref).length < 1 ||
    utf8(req.ref).length > 64
  ) {
    return refuse("InvalidInput"); // :26
  }
  if (i.frozen) return refuse("Frozen"); // :29
  const m = i.mandates.find((x) => x.id === req.mandateId);
  if (m === undefined) return refuse("NoMandate"); // :32-33
  if (m.status === "revoked") return refuse("MandateInactive"); // :34
  if (now >= BigInt(m.expires_at_ns)) return refuse("MandateExpired"); // :37
  if (m.agent_pk !== i.agentPk) return refuse("NotMandateAgent"); // :40
  if (req.amount === 0n) return refuse("ZeroAmount"); // :44
  if (req.amount > BigInt(m.max_per_payment)) return refuse("OverPerPayment"); // :47
  if (m.uses >= m.max_uses) return refuse("UsesExhausted"); // :50
  if (sat(sat(BigInt(m.spent), BigInt(m.reserved)), req.amount) > BigInt(m.max_total)) {
    return refuse("OverMandateTotal"); // :53
  }
  if (i.paidInvoiceHashes.has(req.invoiceHash)) return refuse("DuplicateInvoice"); // :56
  if (i.usedRefs.has(req.ref)) return refuse("DuplicateRef"); // :59
  if (sat(dayTotal, req.amount) > backstop) return refuse("OverDailyBackstop"); // :63
  return { ok: true, wouldHold: req.amount > BigInt(m.approval_above) }; // :66-69
}

/** What the agent would submit for this decision: the chosen mandate, the invoice amount, hash and ref. Null when the amount cannot be a U128 at all. */
function requestFor(i: DecisionInput, d: Decision): SpendRequest | null {
  if (!/^[0-9]+$/.test(i.invoice.amount)) return null;
  return {
    mandateId: d.mandate_id ?? 0,
    amount: BigInt(i.invoice.amount),
    invoiceHash: i.invoice.invoice_hash,
    ref: i.ref,
  };
}

/** The contract code a refusing rule stands for; null for off-chain rules. */
function contractCode(r: RuleResult, i: DecisionInput): ContractCode | null {
  switch (r.id) {
    case "contract.check_failed":
      return "InvalidInput";
    case "vault.frozen":
      return "Frozen";
    case "mandate.none":
      return "NoMandate";
    case "mandate.inactive":
      return "MandateInactive";
    case "mandate.expired":
      return "MandateExpired";
    case "mandate.agent_mismatch":
      return "NotMandateAgent";
    case "invoice.amount_invalid":
      return i.invoice.amount === "0" ? "ZeroAmount" : null; // a model/invoice amount mismatch is off-chain
    case "mandate.over_per_payment":
      return "OverPerPayment";
    case "mandate.uses_exhausted":
      return "UsesExhausted";
    case "mandate.over_total":
      return "OverMandateTotal";
    case "invoice.duplicate":
      return r.detail.startsWith("invoice ") ? "DuplicateInvoice" : "DuplicateRef";
    case "vault.daily_backstop":
      return "OverDailyBackstop";
    default:
      return null;
  }
}

const CONTRACT_ORDER: RuleId[] = [
  "contract.check_failed",
  "vault.frozen",
  "mandate.none",
  "mandate.inactive",
  "mandate.expired",
  "mandate.agent_mismatch",
  "invoice.amount_invalid",
  "mandate.over_per_payment",
  "mandate.uses_exhausted",
  "mandate.over_total",
  "invoice.duplicate",
  "vault.daily_backstop",
];

function mirroredRefusals(i: DecisionInput, d: Decision): { id: RuleId; code: ContractCode }[] {
  return d.rules.flatMap((r) => {
    const code = r.outcome === "refuse" ? contractCode(r, i) : null;
    return code === null ? [] : [{ id: r.id, code }];
  });
}

function assertMirrorsContract(i: DecisionInput): void {
  const d = decide(i);
  const ids = d.rules.map((r) => r.id);
  // The mirrored rules are recorded in the contract's check order.
  expect(ids.filter((id) => CONTRACT_ORDER.includes(id))).toEqual(
    CONTRACT_ORDER.filter((id) => ids.includes(id)),
  );

  const req = requestFor(i, d);
  if (req === null) {
    expect(d.verdict).toBe("refuse"); // the contract could not even receive this amount
    return;
  }
  const oracle = evaluate(i, req);
  // allow / hold => the contract accepts what the agent would submit.
  if (d.verdict !== "refuse") expect(oracle.ok).toBe(true);
  // The first mirrored refusal is the contract's code; no mirrored refusal when the contract accepts.
  expect(mirroredRefusals(i, d)[0]?.code ?? null).toBe(oracle.ok ? null : oracle.code);
}

describe("decide(): one row per built-in rule", () => {
  for (const c of cases) {
    it(c.name, () => {
      const decision = decide(c.input());
      expect(decision.verdict).toBe(c.verdict);
      expect(rule(decision.rules, c.rule[0])?.outcome).toBe(c.rule[1]);
    });
  }

  it("never lets a non-refused decision leave the purpose-matched mandate (nonce binding)", () => {
    for (const c of cases) {
      const i = c.input();
      const decision = decide(i);
      if (decision.verdict === "refuse") continue;
      expect(decision.mandate_id).toBe(
        purposeMatch(i.mandates, i.invoice.purpose_hash, i.now)?.id ?? null,
      );
    }
  });

  it("says plainly that the backstop was not evaluated when daily is null", () => {
    const backstop = rule(decide(input({ daily: null })).rules, "vault.daily_backstop");
    expect(backstop?.outcome).toBe("pass");
    expect(backstop?.detail).toContain("not evaluated");
    expect(backstop?.detail).toContain("daily is null");
  });
});

describe("decide(): purpose pre-selection never lets a dead mandate shadow a live one", () => {
  const dead: [string, Partial<MandateView>][] = [
    ["expired", { expires_at_ns: EXPIRED }],
    ["expiring at this instant", { expires_at_ns: NOW_NS.toString() }],
    ["revoked", { status: "revoked" }],
    ["out of uses", { uses: 10, status: "exhausted" }],
    ["out of total", { spent: "1000000000", status: "exhausted" }],
    ["reserved up to the total", { spent: "900000000", reserved: "100000000" }],
  ];

  it("chooses the live id-2 mandate over a dead id-1 one, and the contract accepts it", () => {
    for (const [label, overrides] of dead) {
      const i = rulesOnly({ mandates: [mandate({ id: 1, ...overrides }), mandate({ id: 2 })] });
      expect(purposeMatch(i.mandates, P1, NOW)?.id, label).toBe(2);
      const d = decide(i);
      expect(d.mandate_id, label).toBe(2);
      expect(d.verdict, label).toBe("allow");
      assertMirrorsContract(i);
    }
  });

  it("takes the lowest live id, whatever order the mandates arrive in", () => {
    const ms = [mandate({ id: 3 }), mandate({ id: 2 }), mandate({ id: 1, status: "revoked" })];
    expect(purposeMatch(ms, P1, NOW)?.id).toBe(2);
    expect(ms.map((m) => m.id)).toEqual([3, 2, 1]); // the caller's array is not reordered
    expect(
      purposeMatch([mandate({ id: 1 }), mandate({ id: 2, status: "revoked" })], P1, NOW)?.id,
    ).toBe(1);
  });

  it("falls back to the lowest-id match when none is live, so the refusal names the real reason", () => {
    const table: [RuleId, MandateView[]][] = [
      [
        "mandate.expired",
        [mandate({ id: 2, status: "revoked" }), mandate({ id: 1, expires_at_ns: EXPIRED })],
      ],
      [
        "mandate.inactive",
        [mandate({ id: 2, expires_at_ns: EXPIRED }), mandate({ id: 1, status: "revoked" })],
      ],
      [
        "mandate.uses_exhausted",
        [
          mandate({ id: 3, expires_at_ns: EXPIRED }),
          mandate({ id: 1, uses: 10, status: "exhausted" }),
          mandate({ id: 2, status: "revoked" }),
        ],
      ],
      [
        "mandate.over_total",
        [
          mandate({ id: 2, status: "revoked" }),
          mandate({ id: 1, spent: "1000000000", status: "exhausted" }),
        ],
      ],
    ];
    for (const [ruleId, mandates] of table) {
      const i = rulesOnly({ mandates });
      const d = decide(i);
      expect(d.mandate_id, ruleId).toBe(1);
      expect(d.verdict, ruleId).toBe("refuse");
      expect(rule(d.rules, ruleId)?.outcome, ruleId).toBe("refuse");
      expect(rule(d.rules, "mandate.none")?.outcome, ruleId).toBe("pass");
      assertMirrorsContract(i);
    }
  });

  it("returns null when no mandate has the purpose, or the invoice has none", () => {
    expect(purposeMatch([mandate({ id: 1 })], sha256Hex("other"), NOW)).toBeNull();
    expect(purposeMatch([mandate({ id: 1 })], null, NOW)).toBeNull();
  });

  it("still takes a trusted proposal's mandate as-is, even when it is dead", () => {
    const i = input({
      mandates: [mandate({ id: 1, expires_at_ns: EXPIRED }), mandate({ id: 2 })],
      proposal: proposal({ mandate_id: 1 }),
    });
    const d = decide(i);
    expect(d.mandate_id).toBe(1);
    expect(d.verdict).toBe("refuse");
    expect(rule(d.rules, "mandate.expired")?.outcome).toBe("refuse");
    expect(rule(d.rules, "invoice.po_mismatch")?.outcome).toBe("refuse"); // the purpose maps to id 2
  });
});

describe("decide(): mirrors the contract's spend check (checks.rs)", () => {
  for (const c of cases.filter((x) => x.skipOracle !== true)) {
    it(`allow implies the contract accepts, refusals carry its code: ${c.name}`, () => {
      assertMirrorsContract(c.input());
    });
  }

  it("keeps an amount above approval_above allowed: the contract holds it on-chain (would_hold)", () => {
    const i = input({ mandates: [mandate({ approval_above: "10000000" })] });
    expect(decide(i).verdict).toBe("allow");
    expect(
      evaluate(i, {
        mandateId: 1,
        amount: 25_000_000n,
        invoiceHash: i.invoice.invoice_hash,
        ref: i.ref,
      }),
    ).toEqual({
      ok: true,
      wouldHold: true,
    });
  });

  it("reports an exhausted mandate through the numeric rules, never as MandateInactive", () => {
    for (const exhausted of [
      mandate({ uses: 10, status: "exhausted" }),
      mandate({ spent: "1000000000", status: "exhausted" }),
    ]) {
      const decision = decide(input({ mandates: [exhausted] }));
      expect(rule(decision.rules, "mandate.inactive")?.outcome).toBe("pass");
      expect(decision.verdict).toBe("refuse");
    }
  });

  // checks.rs:23-65. The first refusing mirrored rule in `rules` is the code `spend` would panic with.
  const precedence: { name: string; input: () => DecisionInput; order: RuleId[] }[] = [
    {
      name: "request shape before frozen",
      input: () => input({ invoice: baseInvoice({ invoice_hash: "zz" }), frozen: true }),
      order: ["contract.check_failed", "vault.frozen"],
    },
    {
      name: "frozen before a missing mandate",
      input: () => input({ frozen: true, proposal: proposal({ mandate_id: 99 }) }),
      order: ["vault.frozen", "mandate.none"],
    },
    {
      name: "revoked before expired",
      input: () => input({ mandates: [mandate({ status: "revoked", expires_at_ns: EXPIRED })] }),
      order: ["mandate.inactive", "mandate.expired"],
    },
    {
      name: "expired before agent mismatch",
      input: () => input({ agentPk: OTHER_AGENT, mandates: [mandate({ expires_at_ns: EXPIRED })] }),
      order: ["mandate.expired", "mandate.agent_mismatch"],
    },
    {
      name: "agent mismatch before zero amount",
      input: () =>
        input({
          agentPk: OTHER_AGENT,
          invoice: baseInvoice({ amount: "0" }),
          proposal: proposal({ amount: "0" }),
        }),
      order: ["mandate.agent_mismatch", "invoice.amount_invalid"],
    },
    {
      name: "zero amount hides the amount-dependent checks",
      input: () =>
        input({
          invoice: baseInvoice({ amount: "0" }),
          proposal: proposal({ amount: "0" }),
          mandates: [mandate({ uses: 10 })],
        }),
      order: ["invoice.amount_invalid"],
    },
    {
      name: "per-payment cap before uses",
      input: () =>
        input({
          invoice: baseInvoice({ amount: "100000001" }),
          proposal: proposal({ amount: "100000001" }),
          mandates: [mandate({ uses: 10 })],
        }),
      order: ["mandate.over_per_payment", "mandate.uses_exhausted"],
    },
    {
      name: "uses before the total",
      input: () => input({ mandates: [mandate({ uses: 10, spent: "990000000" })] }),
      order: ["mandate.uses_exhausted", "mandate.over_total"],
    },
    {
      name: "total before a duplicate invoice",
      input: () =>
        input({
          mandates: [mandate({ spent: "990000000" })],
          paidInvoiceHashes: new Set([sha256Hex("invoice-1")]),
        }),
      order: ["mandate.over_total", "invoice.duplicate"],
    },
    {
      name: "duplicate before the daily backstop",
      input: () =>
        input({
          usedRefs: new Set(["INV-1"]),
          daily: { backstop: "100000000", spent_today: "90000000" },
        }),
      order: ["invoice.duplicate", "vault.daily_backstop"],
    },
  ];
  for (const p of precedence) {
    it(`check order: ${p.name}`, () => {
      const i = p.input();
      expect(mirroredRefusals(i, decide(i)).map((r) => r.id)).toEqual(p.order);
      assertMirrorsContract(i);
    });
  }

  it("a duplicate invoice is reported before a duplicate ref, with the matching contract code", () => {
    const i = input({
      paidInvoiceHashes: new Set([sha256Hex("invoice-1")]),
      usedRefs: new Set(["INV-1"]),
    });
    expect(mirroredRefusals(i, decide(i)).map((r) => r.code)).toEqual(["DuplicateInvoice"]);
    assertMirrorsContract(i);
    const refOnly = input({ usedRefs: new Set(["INV-1"]) });
    expect(mirroredRefusals(refOnly, decide(refOnly)).map((r) => r.code)).toEqual(["DuplicateRef"]);
  });
});

describe("decide(): model trust and decided_by", () => {
  it("marks attested decisions model+rules and others rules-only", () => {
    expect(decide(input()).decided_by).toBe("model+rules");
    expect(decide(input({ attestationOk: false })).decided_by).toBe("rules-only");
    expect(decide(input({ proposal: null, attestationOk: null })).decided_by).toBe("rules-only");
  });

  it("selects by purpose when rules-only and returns the invoice amount, never the model amount", () => {
    const decision = decide(intentsInput({ proposal: null, attestationOk: null }));
    expect(decision.mandate_id).toBe(2);
    expect(decision.amount).toBe("25000000");
    expect(decision.verdict).toBe("allow");
  });

  it("returns a null amount when the invoice amount is invalid", () => {
    expect(decide(input({ invoice: baseInvoice({ amount: "abc" }) })).amount).toBeNull();
  });
});

describe("decide(): the destination is always the mandate's payee", () => {
  // probarion-claim: P-PAYEE
  it("refuses whenever the invoice or the model names another payee, and never outputs a destination", () => {
    const hints: PayeeHint[] = [
      { near_account: "attacker.testnet" },
      { chain: "base", address: BASE_ADDRESS },
      { address: "0x000000000000000000000000000000000000dEaD" },
    ];
    for (const hint of hints) {
      for (const where of ["invoice", "model"] as const) {
        const i =
          where === "invoice"
            ? input({ invoice: baseInvoice({ payee_hint: hint }) })
            : input({ proposal: proposal({ payee_hint: hint }) });
        const decision = decide(i);
        expect(decision.verdict).toBe("refuse");
        expect(rule(decision.rules, "mandate.payee_mismatch")?.outcome).toBe("refuse");
        expect(Object.keys(decision).sort()).toEqual([
          "amount",
          "decided_by",
          "mandate_id",
          "rules",
          "verdict",
        ]);
      }
    }
  });
});

describe("decide(): custom rules", () => {
  it("runs after every built-in rule and can only tighten the verdict", () => {
    const decision = decide(
      input({
        customRules: [
          {
            id: "custom.acme.vendor_hours",
            check: () => ({
              id: "custom.acme.vendor_hours",
              outcome: "hold",
              detail: "outside office hours",
            }),
          },
        ],
      }),
    );
    expect(decision.verdict).toBe("hold");
    expect(decision.rules.at(-1)?.id).toBe("custom.acme.vendor_hours");
    const builtInIds = decision.rules.slice(0, -1).map((r) => r.id);
    expect(builtInIds.every((id) => !id.startsWith("custom."))).toBe(true);
  });

  it("records a custom result under its own id even if it reports a built-in id", () => {
    const decision = decide(
      input({
        customRules: [
          {
            id: "custom.spoof",
            check: () => ({ id: "vault.frozen", outcome: "pass", detail: "spoof" }),
          },
        ],
      }),
    );
    expect(decision.rules.filter((r) => r.id === "vault.frozen")).toHaveLength(1);
    expect(rule(decision.rules, "custom.spoof")?.outcome).toBe("pass");
  });

  it("fails closed when a custom rule throws or returns a bad outcome", () => {
    const throwing = decide(
      input({
        customRules: [
          {
            id: "custom.boom",
            check: () => {
              throw new Error("boom");
            },
          },
        ],
      }),
    );
    expect(throwing.verdict).toBe("refuse");
    expect(rule(throwing.rules, "custom.boom")?.detail).toContain("boom");
    const bad = decide(
      input({
        customRules: [
          {
            id: "custom.bad",
            check: () => ({ id: "custom.bad", outcome: "maybe" as unknown as "pass", detail: "?" }),
          },
        ],
      }),
    );
    expect(bad.verdict).toBe("refuse");
  });
});

describe("decide(): purity", () => {
  /** A deep copy of the input with each Set replaced by its sorted contents, so a mutation of a Set shows up. */
  function snapshot(i: DecisionInput): unknown {
    return structuredClone({
      ...i,
      paidInvoiceHashes: [...i.paidInvoiceHashes].sort(),
      usedRefs: [...i.usedRefs].sort(),
    });
  }
  const withHistory = (): DecisionInput =>
    input({
      paidInvoiceHashes: new Set([sha256Hex("older-b"), sha256Hex("older-a")]),
      usedRefs: new Set(["INV-0", "INV-00"]),
    });

  it("the snapshot notices a change to either Set", () => {
    const i = withHistory();
    const before = snapshot(i);
    (i.usedRefs as Set<string>).add("INV-1");
    expect(snapshot(i)).not.toEqual(before);
    const j = withHistory();
    const beforeJ = snapshot(j);
    (j.paidInvoiceHashes as Set<string>).delete(sha256Hex("older-a"));
    expect(snapshot(j)).not.toEqual(beforeJ);
  });

  it("is deterministic and leaves every input field, Set contents included, untouched", () => {
    for (const make of [withHistory, ...cases.map((c) => c.input)]) {
      const i = make();
      const before = snapshot(i);
      const first = decide(i);
      expect(snapshot(i)).toEqual(before);
      expect(decide(i)).toEqual(first);
      expect(snapshot(i)).toEqual(before);
    }
  });
});

describe("helpers", () => {
  it("validates amounts", () => {
    expect(isPositiveAmount("1")).toBe(true);
    expect(isPositiveAmount("340282366920938463463374607431768211455")).toBe(true);
    expect(isPositiveAmount("340282366920938463463374607431768211456")).toBe(false);
    expect(isPositiveAmount("0")).toBe(false);
    expect(isPositiveAmount(" 1")).toBe(false);
    expect(isPositiveAmount(1)).toBe(false);
  });

  it("prefers the lowest-id live mandate for a purpose", () => {
    const ms = [mandate({ id: 3 }), mandate({ id: 1, status: "revoked" }), mandate({ id: 2 })];
    expect(purposeMatch(ms, P1, NOW)?.id).toBe(2);
    expect(purposeMatch([mandate({ id: 1, status: "revoked" })], P1, NOW)?.id).toBe(1);
    expect(purposeMatch(ms, null, NOW)).toBeNull();
  });

  it("judges expiry against the clock it is given (now >= expires_at_ns is dead)", () => {
    const ms = [mandate({ id: 1, expires_at_ns: NOW_NS.toString() }), mandate({ id: 2 })];
    expect(purposeMatch(ms, P1, NOW)?.id).toBe(2);
    expect(purposeMatch(ms, P1, new Date(NOW.getTime() - 1))?.id).toBe(1);
  });

  it("treats an unreadable clock or expiry as dead, never as live", () => {
    const ms = [mandate({ id: 1, expires_at_ns: "soon" }), mandate({ id: 2 })];
    expect(purposeMatch(ms, P1, NOW)?.id).toBe(2);
    expect(purposeMatch(ms, P1, new Date(Number.NaN))?.id).toBe(1); // nothing live: lowest id
  });

  it("explains payee contradictions", () => {
    expect(payeeHintContradiction(null, mandate().payee)).toBeNull();
    expect(
      payeeHintContradiction({ near_account: " vendor.testnet " }, mandate().payee),
    ).toBeNull();
    expect(payeeHintContradiction({ near_account: "x.testnet" }, mandate().payee)).toContain(
      "x.testnet",
    );
    expect(
      payeeHintContradiction({ near_account: "vendor.testnet" }, BASE_MANDATE.payee),
    ).toContain("NEAR account");
  });

  it("describes payees", () => {
    expect(describePayee(mandate().payee)).toBe("near:vendor.testnet");
    expect(describePayee(BASE_MANDATE.payee)).toBe(
      `base:${BASE_ADDRESS} (base-usdc.probarion.testnet)`,
    );
  });
});
