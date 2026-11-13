import { isEvmAddress, isSolanaAddress } from "./formats.js";
import { isHex32, utf8 } from "./hex.js";
import type {
  CustomRule,
  Decision,
  DecisionInput,
  MandateView,
  ModelProposal,
  Payee,
  PayeeHint,
  RuleId,
  RuleResult,
} from "./types.js";

export const DEFAULT_CONFIDENCE_FLOOR = 0.7;

const AMOUNT_RE = /^[1-9][0-9]{0,38}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,38})$/;
const U128_MAX = (1n << 128n) - 1n;
const NS_PER_MS = 1_000_000n;
const REF_MAX_BYTES = 64; // contracts/vault/src/validate.rs `is_ref`: 1-64 bytes
const OUTCOMES: ReadonlySet<string> = new Set(["pass", "hold", "refuse"]);

type Push = (id: RuleId, outcome: RuleResult["outcome"], detail: string) => void;

export function isPositiveAmount(value: unknown): value is string {
  return typeof value === "string" && AMOUNT_RE.test(value) && BigInt(value) <= U128_MAX;
}

/** Parses a contract U128/U64 decimal string; null when it is not one, so callers can fail closed. */
function toBig(value: string): bigint | null {
  if (typeof value !== "string" || !UINT_RE.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= U128_MAX ? parsed : null;
}

/** Rust `u128::saturating_add`: the contract sums with it (checks.rs:53, :63). */
function satAdd(a: bigint, b: bigint): bigint {
  const sum = a + b;
  if (sum > U128_MAX) return U128_MAX;
  return sum;
}

function clip(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** `now >= expires_at_ns` (checks.rs:37); null when the clock or the expiry is unreadable. */
function hasExpired(now: Date, expiresAtNs: string): boolean | null {
  const nowMs = now.getTime();
  const expiresNs = toBig(expiresAtNs);
  if (Number.isNaN(nowMs) || expiresNs === null) return null;
  return BigInt(nowMs) * NS_PER_MS >= expiresNs;
}

/**
 * Whether the contract could still accept a spend from `agentPk` on this mandate at `now`: not
 * revoked (checks.rs:34), not expired (:37), bound to this agent (:40), a use left (:50), and room
 * under the total for the smallest amount, 1 (:53). Unreadable numbers count as not spendable.
 */
function spendable(m: MandateView, now: Date, agentPk: string): boolean {
  if (m.status === "revoked") return false;
  if (hasExpired(now, m.expires_at_ns) !== false) return false;
  if (m.agent_pk !== agentPk) return false;
  if (!(m.uses < m.max_uses)) return false; // written so a NaN or missing count fails closed
  const spent = toBig(m.spent);
  const reserved = toBig(m.reserved);
  const total = toBig(m.max_total);
  if (spent === null || reserved === null || total === null) return false;
  return satAdd(satAdd(spent, reserved), 1n) <= total;
}

/**
 * The mandate the code pre-selects for a purpose: the lowest-id one that is not revoked, not expired
 * at `now`, bound to `agentPk`, has a use left and room under its total. A dead or foreign mandate
 * (another agent's, e.g. after a key rotation or with two agents on one PO) never shadows a payable
 * one. If none qualifies it falls back to the lowest-id match, so the decision still refuses with the
 * precise reason (inactive, expired, agent_mismatch, uses_exhausted, over_total) instead of "no
 * mandate". A trusted `proposal.mandate_id` bypasses this.
 */
export function purposeMatch(
  mandates: readonly MandateView[],
  purposeHash: string | null,
  now: Date,
  agentPk: string,
): MandateView | null {
  if (purposeHash === null) return null;
  const matches = mandates
    .filter((m) => m.purpose_hash === purposeHash)
    .sort((a, b) => a.id - b.id);
  return matches.find((m) => spendable(m, now, agentPk)) ?? matches[0] ?? null;
}

export function describePayee(payee: Payee): string {
  return payee.type === "near"
    ? `near:${payee.account_id}`
    : `${payee.chain}:${payee.address} (${payee.asset})`;
}

function sameAddress(chain: "base" | "solana", a: string, b: string): boolean {
  return chain === "base" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// The label a model may write after the asset account, as in "base-usdc.probarion.testnet (asset)":
// one space, then parentheses around 1 to 40 characters of ASCII letters in words joined by single
// spaces. No dot, digit, colon or other sign fits, so the label cannot hold a dotted account such as
// vendor.testnet, an implicit or 0x account, a Base address or a number. A bare word still fits
// ("near", "ten"); like the hint's name, it is compared, not sent, and the contract pays only the
// mandate's payee.
const ASSET_LABEL = /^ \((?=[A-Za-z ]{1,40}\)$)[A-Za-z]+(?: [A-Za-z]+)*\)$/;

/** True if `value` is `asset` exactly, or `asset` followed by one ASSET_LABEL. */
function isOwnAssetValue(value: string | undefined, asset: string): boolean {
  if (value === undefined || !value.startsWith(asset)) return false;
  const rest = value.slice(asset.length);
  return rest === "" || ASSET_LABEL.test(rest);
}

/**
 * Returns why the hint contradicts the mandate payee, or null. A payee name never contradicts.
 * `ownAssetNamesNoPayee`: the hint is the trusted model proposal's, so for a Base or Solana payee
 * the mandate's own asset account in near_account names no other payee (see below). Leave it off
 * for the invoice's hint.
 */
export function payeeHintContradiction(
  hint: PayeeHint | null,
  payee: Payee,
  opts: { ownAssetNamesNoPayee?: boolean } = {},
): string | null {
  if (hint === null) return null;
  const near = hint.near_account?.trim() ?? "";
  const address = hint.address?.trim() ?? "";
  const chain = hint.chain;
  // The v1 proposal schema has no NEAR value in its chain enum and no account field but
  // near_account, so a model may put the mandate's own NEAR account in near_account or in address,
  // next to base or solana. That account names no other payee, in either field and whatever the
  // chain, so only a value that differs from it (compared exactly) contradicts. An account that is
  // also a valid Base or Solana address (an ETH-implicit 0x and 40 hex account, for example) names
  // that address too, so given as an address it still contradicts. A chain alone, with no account
  // or address, still contradicts.
  //
  // For a Base or Solana payee, the model is shown the mandate's payee, its asset account
  // (payee.asset, the token's NEAR Intents id) included, and may copy that account into
  // near_account next to the right address: two attested models did on NEAR mainnet on 2026-11-13
  // (ledger entries 0 and 1 of v0.probarion.near). So in the trusted proposal's hint
  // (ownAssetNamesNoPayee) that account names no other payee: it is the token the mandate pays in.
  // The untrimmed value must equal payee.asset in every character, or be payee.asset followed by
  // one short label in parentheses (ASSET_LABEL): an attested model wrote "<asset> (asset)" in a
  // testnet rehearsal on 2026-11-13. Any other near_account, the asset in another case or with
  // spaces around it included, still contradicts, and when only spaces differ the detail quotes the
  // value as given. In the invoice's hint, read from text anyone can write,
  // any near_account still contradicts, the asset included: the console reads only the first NEAR
  // account in an invoice's text, so the asset written first could hide another payee. The chain
  // and address checks are unchanged, so the asset given as the address contradicts too.
  if (payee.type === "near") {
    if (near !== "" && near !== payee.account_id) {
      return `invoice names NEAR account ${near}; the mandate pays ${payee.account_id}`;
    }
    const ownAccount =
      address === payee.account_id && !isEvmAddress(address) && !isSolanaAddress(address);
    if (address !== "" && !ownAccount) {
      return `invoice names ${chain ?? "an external"} address ${address}; the mandate pays NEAR account ${payee.account_id}`;
    }
    if (chain !== undefined && near === "" && address === "") {
      return `invoice names chain ${chain}; the mandate pays NEAR account ${payee.account_id}`;
    }
    return null;
  }
  const ownAsset = opts.ownAssetNamesNoPayee === true;
  if (near !== "" && !(ownAsset && isOwnAssetValue(hint.near_account, payee.asset))) {
    const given =
      ownAsset && isOwnAssetValue(near, payee.asset)
        ? ` (given as ${JSON.stringify(hint.near_account)})`
        : "";
    const pays = `${payee.chain}:${payee.address}`;
    return `invoice names NEAR account ${near}${given}; the mandate pays ${pays}`;
  }
  if (chain !== undefined && chain !== payee.chain) {
    return `invoice names chain ${chain}; the mandate pays on ${payee.chain}`;
  }
  if (address !== "" && !sameAddress(payee.chain, address, payee.address)) {
    return `invoice names address ${address}; the mandate pays ${payee.address}`;
  }
  return null;
}

/** Mirror of the contract's `InvalidInput` (checks.rs:26 with validate.rs `is_hex64` and `is_ref`). */
function requestShapeProblem(input: DecisionInput): string | null {
  if (!isHex32(input.invoice.invoice_hash)) {
    return "InvalidInput: invoice_hash must be 64 lowercase hex characters";
  }
  const refBytes = typeof input.ref === "string" ? utf8(input.ref).length : 0;
  if (refBytes < 1 || refBytes > REF_MAX_BYTES) {
    return `InvalidInput: ref must be 1-${REF_MAX_BYTES} bytes, got ${refBytes}`;
  }
  return null;
}

/** NoMandate's successors in checks.rs order: revoked (:34), expired (:37), agent (:40). */
function identityRules(input: DecisionInput, m: MandateView, push: Push): void {
  // Only `revoked` is MandateInactive. A mandate whose status is `exhausted` is refused by the
  // contract as UsesExhausted / OverMandateTotal, which `limitRules` mirrors.
  const revoked = m.status === "revoked";
  push(
    "mandate.inactive",
    revoked ? "refuse" : "pass",
    revoked ? `mandate ${m.id} is revoked` : `mandate ${m.id} is not revoked (status ${m.status})`,
  );

  // Expiry comes from expires_at_ns, never from the status: `active` also covers an expired mandate.
  const expired = hasExpired(input.now, m.expires_at_ns);
  if (expired === null) {
    push("mandate.expired", "refuse", "clock or mandate expiry unreadable: refused");
  } else {
    push(
      "mandate.expired",
      expired ? "refuse" : "pass",
      `${expired ? "expired" : "expires"} at ${m.expires_at_ns} ns`,
    );
  }

  const agentOk = m.agent_pk === input.agentPk;
  push(
    "mandate.agent_mismatch",
    agentOk ? "pass" : "refuse",
    agentOk
      ? "agent key matches the mandate"
      : `mandate ${m.id} is bound to ${m.agent_pk}, not ${input.agentPk}`,
  );
}

/** Off-chain: keeps every non-refused decision on the mandate committed in the nonce, and the destination on the mandate. */
function bindingRules(
  input: DecisionInput,
  m: MandateView,
  byPurpose: MandateView | null,
  trusted: ModelProposal | null,
  push: Push,
): void {
  const ph = input.invoice.purpose_hash;
  if (ph === null) {
    push("invoice.po_mismatch", "refuse", "invoice has no purpose_hash (no PO reference)");
  } else if (m.purpose_hash !== ph) {
    push(
      "invoice.po_mismatch",
      "refuse",
      `invoice purpose ${ph} differs from mandate ${m.id} purpose ${m.purpose_hash}`,
    );
  } else if (byPurpose !== null && byPurpose.id !== m.id) {
    push(
      "invoice.po_mismatch",
      "refuse",
      `invoice purpose maps to mandate ${byPurpose.id}, not ${m.id}`,
    );
  } else {
    push("invoice.po_mismatch", "pass", `purpose matches mandate ${m.id}`);
  }

  const reason =
    payeeHintContradiction(input.invoice.payee_hint, m.payee) ??
    payeeHintContradiction(trusted?.payee_hint ?? null, m.payee, { ownAssetNamesNoPayee: true });
  push(
    "mandate.payee_mismatch",
    reason === null ? "pass" : "refuse",
    reason ?? `destination is the mandate payee ${describePayee(m.payee)}`,
  );
}

/** ZeroAmount (checks.rs:44) plus the off-chain checks that the amount is a canonical integer the model agrees with. */
function amountRule(
  input: DecisionInput,
  trusted: ModelProposal | null,
  push: Push,
): bigint | null {
  const text: unknown = input.invoice.amount;
  if (!isPositiveAmount(text)) {
    push(
      "invoice.amount_invalid",
      "refuse",
      `invoice amount ${JSON.stringify(text)} is not a positive integer in smallest units`,
    );
    return null;
  }
  if (trusted !== null && trusted.amount !== null && trusted.amount !== text) {
    push(
      "invoice.amount_invalid",
      "refuse",
      `model amount ${trusted.amount} differs from invoice amount ${text}`,
    );
  } else {
    push("invoice.amount_invalid", "pass", `amount ${text}`);
  }
  return BigInt(text);
}

/** Per-payment cap (checks.rs:47), uses (:50) and the mandate total (:53). */
function limitRules(m: MandateView, amount: bigint, push: Push): void {
  const perPayment = toBig(m.max_per_payment);
  push(
    "mandate.over_per_payment",
    perPayment === null || amount > perPayment ? "refuse" : "pass",
    `amount ${amount} vs per-payment cap ${m.max_per_payment}`,
  );
  push(
    "mandate.uses_exhausted",
    // checks.rs:50 refuses `uses >= max_uses`; written as a negated `<` so a NaN count refuses too.
    m.uses < m.max_uses ? "pass" : "refuse",
    `${m.uses} of ${m.max_uses} uses consumed`,
  );

  const spent = toBig(m.spent);
  const reserved = toBig(m.reserved);
  const total = toBig(m.max_total);
  if (spent === null || reserved === null || total === null) {
    push("mandate.over_total", "refuse", "mandate spent, reserved or total unreadable: refused");
    return;
  }
  const committed = satAdd(satAdd(spent, reserved), amount);
  push(
    "mandate.over_total",
    committed > total ? "refuse" : "pass",
    `spent + reserved + amount = ${committed} vs total cap ${total}`,
  );
}

/** DuplicateInvoice (checks.rs:56) then DuplicateRef (:59). */
function duplicateRule(input: DecisionInput, push: Push): void {
  if (input.paidInvoiceHashes.has(input.invoice.invoice_hash)) {
    push(
      "invoice.duplicate",
      "refuse",
      `invoice ${input.invoice.invoice_hash} was already paid or is pending`,
    );
  } else if (input.usedRefs.has(input.ref)) {
    push("invoice.duplicate", "refuse", `ref ${input.ref} was already used`);
  } else {
    push("invoice.duplicate", "pass", "invoice and ref are unused");
  }
}

/** OverDailyBackstop (checks.rs:63): `spent_today` is the contract's total for the UTC day of `now`. */
function dailyRule(daily: DecisionInput["daily"], amount: bigint | null, push: Push): void {
  if (daily === null) {
    push(
      "vault.daily_backstop",
      "pass",
      "daily backstop not evaluated: daily is null (no daily data supplied); check_spend still enforces it on-chain",
    );
  } else if (amount === null) {
    push(
      "vault.daily_backstop",
      "pass",
      "daily backstop not evaluated: the invoice amount is invalid",
    );
  } else {
    const spentToday = toBig(daily.spent_today);
    const limit = toBig(daily.backstop);
    if (spentToday === null || limit === null) {
      push("vault.daily_backstop", "refuse", "daily spent or backstop unreadable: refused");
      return;
    }
    const today = satAdd(spentToday, amount);
    push(
      "vault.daily_backstop",
      today > limit ? "refuse" : "pass",
      `today ${today} of backstop ${limit}`,
    );
  }
}

function intentsRule(input: DecisionInput, m: MandateView, amount: bigint, push: Push): void {
  if (m.payee.type !== "intents") {
    push("intents.balance_low", "pass", "not an Intents payee");
  } else if (input.intentsBalance === null) {
    push("intents.balance_low", "hold", "POA balance in intents is unknown");
  } else if (input.intentsBalance < amount) {
    push(
      "intents.balance_low",
      "hold",
      `POA balance ${input.intentsBalance} < amount ${amount}: the owner must top up`,
    );
  } else {
    push("intents.balance_low", "pass", `POA balance ${input.intentsBalance}`);
  }
}

function modelRules(trusted: ModelProposal, confidenceFloor: number, push: Push): void {
  if (trusted.action === "pay") push("model.refused", "pass", "model proposed pay");
  else if (trusted.action === "hold")
    push("model.refused", "hold", `model asked to hold: ${clip(trusted.reasoning)}`);
  else if (trusted.action === "refuse")
    push("model.refused", "refuse", `model refused: ${clip(trusted.reasoning)}`);
  else
    push(
      "model.refused",
      "refuse",
      `model action ${JSON.stringify(trusted.action)} is not recognised: refused`,
    );
  // Written as `!(>=)` so a NaN confidence holds instead of passing.
  push(
    "model.low_confidence",
    trusted.confidence >= confidenceFloor ? "pass" : "hold",
    `confidence ${trusted.confidence} (floor ${confidenceFloor})`,
  );
}

function runCustomRule(
  rule: CustomRule,
  input: DecisionInput,
  chosen: MandateView | null,
): RuleResult {
  if (!rule.id.startsWith("custom.")) {
    return { id: rule.id, outcome: "refuse", detail: "custom rule id must start with custom." };
  }
  try {
    const result = rule.check(input, chosen);
    if (!OUTCOMES.has(result.outcome)) {
      return {
        id: rule.id,
        outcome: "refuse",
        detail: `custom rule returned invalid outcome ${String(result.outcome)}`,
      };
    }
    return { id: rule.id, outcome: result.outcome, detail: String(result.detail) };
  } catch (error) {
    return {
      id: rule.id,
      outcome: "refuse",
      detail: `custom rule threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Pure and deterministic. Built-in rules run first, cannot be removed, and a custom rule can only
 * tighten the verdict.
 *
 * Rules that mirror the vault's `check_spend` are recorded in the contract's own check order
 * (contracts/vault/src/checks.rs `Vault::evaluate`), with its operators, so the first refusing
 * mirrored rule is the code `spend` would panic with. Off-chain rules (purpose, payee, Intents
 * balance, model) sit between them.
 *
 * What the caller must supply, because `DecisionInput` cannot:
 * - `agentPk` is the vault's own registered agent key. The contract's `NotAgent` (checks.rs:23) has
 *   no counterpart here, since there is no agent registry in the input.
 * - `daily.spent_today` is the contract's total for the UTC day of `now` (bucket `ts / DAY_NS`;
 *   0 when the bucket is another day). `decide` takes it as given.
 * - With `daily: null` the backstop is recorded as not evaluated and does not refuse. The SDK's
 *   `check_spend` dry run, which runs before every `spend`, still catches `OverDailyBackstop`.
 */
export function decide(input: DecisionInput): Decision {
  const rules: RuleResult[] = [];
  const push: Push = (id, outcome, detail) => {
    rules.push({ id, outcome, detail });
  };

  const shape = requestShapeProblem(input);
  if (shape !== null) push("contract.check_failed", "refuse", shape); // InvalidInput, checks.rs:26

  push(
    "vault.frozen",
    input.frozen ? "refuse" : "pass",
    input.frozen ? "vault is frozen" : "vault is not frozen",
  ); // :29

  let trusted: ModelProposal | null = null;
  if (input.proposal !== null) {
    if (input.attestationOk === true) {
      trusted = input.proposal;
    } else {
      push(
        "model.attestation_invalid",
        "pass",
        input.attestationOk === false
          ? "attestation checks failed: proposal ignored, decided rules-only"
          : "proposal carries no attestation: ignored, decided rules-only",
      );
    }
  } else if (input.attestationOk === false) {
    push("model.unavailable", "pass", "model unavailable: decided rules-only");
  }

  const proposedId = trusted?.mandate_id ?? null;
  const byPurpose = purposeMatch(
    input.mandates,
    input.invoice.purpose_hash,
    input.now,
    input.agentPk,
  );
  const chosen =
    proposedId !== null ? (input.mandates.find((m) => m.id === proposedId) ?? null) : byPurpose;

  let amount: bigint | null;
  if (chosen === null) {
    push(
      "mandate.none", // NoMandate, :32
      "refuse",
      proposedId !== null
        ? `mandate ${proposedId} proposed by the model does not exist`
        : "no mandate matches the invoice purpose",
    );
    amount = amountRule(input, trusted, push);
    duplicateRule(input, push);
    dailyRule(input.daily, amount, push);
  } else {
    push(
      "mandate.none",
      "pass",
      `mandate ${chosen.id} selected by ${proposedId !== null ? "proposal" : "purpose_hash"}`,
    );
    identityRules(input, chosen, push); // :34, :37, :40
    bindingRules(input, chosen, byPurpose, trusted, push);
    amount = amountRule(input, trusted, push); // ZeroAmount, :44
    if (amount !== null) limitRules(chosen, amount, push); // :47, :50, :53
    duplicateRule(input, push); // :56, :59
    dailyRule(input.daily, amount, push); // :63
    if (amount !== null) intentsRule(input, chosen, amount, push);
  }

  if (trusted !== null) modelRules(trusted, input.confidenceFloor, push);

  for (const custom of input.customRules ?? []) rules.push(runCustomRule(custom, input, chosen));

  const verdict = rules.some((r) => r.outcome === "refuse")
    ? "refuse"
    : rules.some((r) => r.outcome === "hold")
      ? "hold"
      : "allow";
  return {
    verdict,
    mandate_id: chosen?.id ?? null,
    amount: amount === null ? null : input.invoice.amount,
    rules,
    decided_by: trusted === null ? "rules-only" : "model+rules",
  };
}
