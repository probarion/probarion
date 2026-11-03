/**
 * The mandate create form's rules, and how a mandate read from the chain is worded. No SDK, no I/O, no
 * server-only import: the same `buildMandateInput` runs in the browser (instant field errors) and in the
 * server action (authoritative), so a forged client form meets the same checks.
 *
 * The contract is the ABI (contracts/vault/src/mandates.rs `validate_mandate`, validate.rs). What it
 * refuses, this refuses first, so the owner never signs (and pays gas for) a call that will fail:
 *  - `purpose_hash`: 64 LOWERCASE hex (the form lowercases what was pasted, then sends lowercase);
 *  - `0 < max_per_payment <= max_total`, `approval_above >= 0`, all U128 (parseUsdc is bounded at 2^128-1);
 *  - `max_uses > 0` (a u32);
 *  - `expires_at_ns > block_timestamp` (a U64);
 *  - `label` at most 64 BYTES of what is sent;
 *  - a NEAR payee is an account id (the grammar in validate.ts) other than the vault itself;
 *  - an Intents payee: `0x` + 40 hex, and an asset the vault allows whose prefix names the chain (`base-`).
 *
 * Where it is stricter than the contract (each is a deliberate choice, named here so nobody mistakes it
 * for a contract rule): a mixed-case Base address must be a valid EIP-55 checksum and the zero address is
 * refused (parseBaseAddress); the label is not empty and has no control, direction or lone-surrogate
 * characters; `max_uses` is at most 10,000 and the expiry at most 366 days ahead during the beta; and the
 * agent key must be one of the vault's active agent keys (the contract does not check it at creation, but
 * a mandate for a key that cannot spend is useless).
 *
 * The console offers NEAR and Base payees. The contract also knows Solana; it is not offered here.
 */
import type { MandateView } from "@probarion/core";
import type { Tone } from "@/components/ui";
import { mandateStatusView } from "@/lib/console/display";
import { actionKey } from "@/lib/near/lock";
import type { MandateInputJson, WalletTx } from "@/lib/near/tx";
import { AmountError, dateToNs, formatUsdc, parseUsdc } from "@/lib/near/units";
import { isNearAccountId, parseBaseAddress } from "@/lib/near/validate";

export interface MandateForm {
  payeeKind: "near" | "base";
  payee: string;
  purposeHash: string; // sha256 of the PO / purpose document, 64 hex
  maxPerPaymentUsdc: string;
  maxTotalUsdc: string;
  maxUses: string;
  expiresOn: string; // YYYY-MM-DD, the end of that UTC day
  approvalAboveUsdc: string;
  agentPk: string;
  label: string;
}

export interface MandateContext {
  now: Date;
  vault: string;
  baseAsset: string; // NETWORKS[net].allowedAssets.base
  allowedAssets: readonly string[]; // from the vault's get_config()
  agentKeys: readonly string[]; // from list_agents()
}

export type MandateErrors = Partial<Record<keyof MandateForm, string>>;

export type MandateCheck =
  | { ok: true; input: MandateInputJson }
  | { ok: false; errors: MandateErrors };

/** validate.rs: `label.len() <= 64`, bytes. */
export const LABEL_MAX_BYTES = 64;
/** A beta limit, not the contract's (a u32). */
export const MAX_USES_BETA = 10_000;
/** A beta limit, not the contract's. */
export const MAX_EXPIRY_AHEAD_MS = 366 * 24 * 3600_000;

const U64_MAX = 2n ** 64n - 1n;
const NS_PER_MS = 1_000_000n;
const DIGITS = /^(0|[1-9][0-9]*)$/;
/** Control, format (direction marks, zero-width), surrogate, and line/paragraph separator characters. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_TEXT_ALL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

export const FIELD_LABEL: Record<keyof MandateForm, string> = {
  payeeKind: "Payee type",
  payee: "Payee",
  purposeHash: "Purpose document hash",
  maxPerPaymentUsdc: "Max per payment",
  maxTotalUsdc: "Max total",
  maxUses: "Max number of payments",
  expiresOn: "Expires on",
  approvalAboveUsdc: "Hold for approval above",
  agentPk: "Agent key",
  label: "Name",
};

/** `Payee: Not a valid Base address … · Max total: …`, for one line of text (a server action's answer). */
export function describeErrors(errors: MandateErrors): string {
  return (Object.entries(errors) as [keyof MandateForm, string][])
    .map(([field, message]) => `${FIELD_LABEL[field]}: ${message}`)
    .join(" · ");
}

const FORM_TEXT_KEYS = [
  "payee",
  "purposeHash",
  "maxPerPaymentUsdc",
  "maxTotalUsdc",
  "maxUses",
  "expiresOn",
  "approvalAboveUsdc",
  "agentPk",
  "label",
] as const;

/**
 * What a server action takes from the browser: the ten form fields, each a string of at most 1,000
 * characters, and nothing else (a vault, a tenant, an owner, a deposit sent along is dropped). A field of
 * another type is empty text, and a payee kind that is neither `near` nor `base` stays unknown, so the
 * builder refuses it instead of reading it as NEAR.
 */
export function asMandateForm(raw: unknown): MandateForm {
  const src = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out = {} as MandateForm;
  for (const k of FORM_TEXT_KEYS) {
    const v = src[k];
    out[k] = typeof v === "string" ? v.slice(0, 1_000) : "";
  }
  const kind = src.payeeKind;
  out.payeeKind = kind === "near" || kind === "base" ? kind : ("" as MandateForm["payeeKind"]);
  return out;
}

/** A USDC amount field: an AmountError is the field's message. `positive` also refuses zero. */
function amountField(
  errors: MandateErrors,
  field: keyof MandateForm,
  text: string,
  positive: boolean,
): bigint | null {
  try {
    const units = BigInt(parseUsdc(text));
    if (positive && units === 0n) {
      errors[field] = "Must be above 0";
      return null;
    }
    return units;
  } catch (e) {
    errors[field] = e instanceof AmountError ? e.message : "Invalid amount";
    return null;
  }
}

export function buildMandateInput(form: MandateForm, ctx: MandateContext): MandateCheck {
  const errors: MandateErrors = {};

  // ---- payee ----
  let payee: MandateInputJson["payee"] | null = null;
  const rawPayee = form.payee.trim();
  if (form.payeeKind === "near") {
    if (!isNearAccountId(rawPayee)) {
      errors.payee = "Not a NEAR account id (they are lowercase, e.g. designer.near)";
    } else if (rawPayee === ctx.vault) {
      errors.payee = "A vault cannot pay itself";
    } else {
      payee = { type: "near", account_id: rawPayee };
    }
  } else if (form.payeeKind === "base") {
    const address = parseBaseAddress(rawPayee);
    if (!address) {
      errors.payee =
        "Not a valid Base address (0x + 40 hex; a mixed-case address must match its checksum)";
    } else if (!ctx.baseAsset.startsWith("base-") || !isNearAccountId(ctx.baseAsset)) {
      // validate.rs asset_matches_chain: a POA asset id carries its chain as a prefix
      errors.payee = "The asset configured for Base is not a Base asset";
    } else if (!ctx.allowedAssets.includes(ctx.baseAsset)) {
      errors.payee = "This vault does not allow Base USDC payouts";
    } else {
      payee = { type: "intents", chain: "base", address, asset: ctx.baseAsset };
    }
  } else {
    errors.payeeKind = "Pick NEAR account or Base address";
  }

  // ---- purpose document ----
  const purpose = form.purposeHash.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(purpose)) {
    errors.purposeHash =
      "Choose the PO or purpose document, or paste its sha256 (64 hex digits, no 0x)";
  }

  // ---- amounts ----
  const perPayment = amountField(errors, "maxPerPaymentUsdc", form.maxPerPaymentUsdc, true);
  const total = amountField(errors, "maxTotalUsdc", form.maxTotalUsdc, true);
  const approvalAbove = amountField(errors, "approvalAboveUsdc", form.approvalAboveUsdc, false);
  if (perPayment !== null && total !== null && perPayment > total) {
    errors.maxPerPaymentUsdc = "Per-payment cap cannot exceed the total";
  }

  // ---- number of payments ----
  const usesText = form.maxUses.trim();
  let uses = 0;
  if (!/^[1-9][0-9]{0,9}$/.test(usesText)) {
    errors.maxUses = `Whole number from 1 to ${MAX_USES_BETA}`;
  } else {
    uses = Number(usesText);
    if (uses > MAX_USES_BETA) errors.maxUses = `At most ${MAX_USES_BETA} payments during the beta`;
  }

  // ---- expiry ----
  let expiresNs = "0";
  try {
    expiresNs = dateToNs(form.expiresOn);
    const expires = BigInt(expiresNs);
    const nowNs = BigInt(ctx.now.getTime()) * NS_PER_MS;
    if (expires <= nowNs) errors.expiresOn = "Expiry must be in the future";
    else if (expires - nowNs > BigInt(MAX_EXPIRY_AHEAD_MS) * NS_PER_MS) {
      errors.expiresOn = "At most one year ahead during the beta";
    } else if (expires > U64_MAX) errors.expiresOn = "Too far ahead";
  } catch (e) {
    errors.expiresOn = e instanceof AmountError ? e.message : "Invalid date";
  }

  // ---- agent ----
  if (!ctx.agentKeys.includes(form.agentPk)) {
    errors.agentPk = "Pick an agent key that is active on this vault";
  }

  // ---- label ----
  const label = form.label.trim();
  if (label === "") errors.label = "Give the mandate a name";
  else if (UNSAFE_TEXT.test(label)) {
    errors.label = "Use plain text: no line breaks, control or direction characters";
  } else {
    const bytes = new TextEncoder().encode(label).length;
    if (bytes > LABEL_MAX_BYTES)
      errors.label = `At most ${LABEL_MAX_BYTES} bytes (this is ${bytes})`;
  }

  if (
    Object.keys(errors).length > 0 ||
    !payee ||
    perPayment === null ||
    total === null ||
    approvalAbove === null
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    input: {
      payee,
      purpose_hash: purpose,
      max_per_payment: perPayment.toString(),
      max_total: total.toString(),
      max_uses: uses,
      expires_at_ns: expiresNs,
      approval_above: approvalAbove.toString(),
      agent_pk: form.agentPk,
      label,
    },
  };
}

// ---- what the contract will do with the approval threshold ---------------------------------------

/** checks.rs: a spend is held when `amount > approval_above`. */
export function approvalSummary(input: MandateInputJson): string {
  const above = BigInt(input.approval_above);
  if (above === 0n) return "Every payment is held for an approver's signature.";
  if (above >= BigInt(input.max_per_payment)) {
    return "No payment is held for approval: every payment up to the per-payment cap is paid at once.";
  }
  return `Payments above ${formatUsdc(input.approval_above)} USDC are held for an approver's signature; smaller ones are paid at once.`;
}

// ---- R3: warnings that do not block ---------------------------------------------------------------

/** A vault balance that was read (base units), or one that could not be. Never a stand-in zero. */
export type FloatRead = { ok: true; units: string } | { ok: false };

const FLOAT_SOURCE = { near: "USDC on NEAR", base: "Base USDC in Intents" } as const;

/**
 * R3. A NEAR payee is paid from the vault's USDC on NEAR, a Base payee from its Base USDC in Intents. When
 * the per-payment cap is above what that balance holds now, a payment at the cap would fail until the
 * vault is topped up: the owner may still create the mandate, so this is a warning. When the balance
 * could not be read the text says "balance unavailable" and never a zero.
 */
export function floatWarning(a: {
  payeeKind: "near" | "base";
  maxPerPaymentUnits: string | null;
  float: FloatRead;
}): string | null {
  const source = FLOAT_SOURCE[a.payeeKind];
  if (!a.float.ok || !DIGITS.test(a.float.units)) {
    return `Balance unavailable: the console could not read the vault's ${source}, so it cannot tell whether a payment up to this cap could be paid.`;
  }
  if (a.maxPerPaymentUnits === null || !DIGITS.test(a.maxPerPaymentUnits)) return null;
  const cap = BigInt(a.maxPerPaymentUnits);
  const float = BigInt(a.float.units);
  if (cap <= float) return null;
  return `The per-payment cap (${formatUsdc(cap.toString())} USDC) is more than the ${source} the vault holds now (${formatUsdc(float.toString())} USDC). You can still create the mandate, but a payment above ${formatUsdc(float.toString())} USDC will fail until you add funds.`;
}

/** R3: a NEAR payee is paid from the vault's USDC on NEAR, a Base payee from its Base USDC in Intents. */
export function floatFor<T>(kind: "near" | "base", floats: { near: T; base: T }): T {
  return kind === "base" ? floats.base : floats.near;
}

export const CHANGED_SINCE_REVIEW =
  "The vault changed since you reviewed this form, so nothing was signed. Check the fields and try again.";

/**
 * The server prepares the transaction again from the chain as it is now. What the wallet is asked to
 * sign must be exactly the transaction the owner reviewed (`expectedKey` is the lock key of that
 * transaction: its receiver, methods, arguments, gas and deposit). The server's own refusal passes
 * through; with nothing reviewed to compare against, nothing is signed.
 */
export function checkPrepared(
  answer: WalletTx | { error: string; status?: number },
  expectedKey: string | null,
): WalletTx | { error: string; status?: number } {
  if ("error" in answer) return answer;
  // (a null key equals no transaction's key, so "nothing reviewed" refuses too)
  if (actionKey(answer) !== expectedKey) {
    return { error: CHANGED_SINCE_REVIEW };
  }
  return answer;
}

/** checks.rs `OverDailyBackstop`: a day's total, with the payment, may not pass the vault's daily backstop. */
export function backstopWarning(
  maxPerPaymentUnits: string | null,
  dailyBackstop: string,
): string | null {
  if (
    maxPerPaymentUnits === null ||
    !DIGITS.test(maxPerPaymentUnits) ||
    !DIGITS.test(dailyBackstop)
  ) {
    return null;
  }
  if (BigInt(maxPerPaymentUnits) <= BigInt(dailyBackstop)) return null;
  return `The per-payment cap (${formatUsdc(maxPerPaymentUnits)} USDC) is above this vault's daily backstop (${formatUsdc(dailyBackstop)} USDC): the contract refuses any payment that would take a day's total past the backstop (OverDailyBackstop).`;
}

/** The amount typed in the cap field as base units, or null while it is not a valid amount. */
export function tryUsdcUnits(text: string): string | null {
  try {
    return parseUsdc(text);
  } catch {
    return null;
  }
}

// ---- reading a mandate back from the chain --------------------------------------------------------

/** Text that came from the chain, made safe to show: controls and direction marks replaced, length cut. */
export function safeChainText(value: unknown, max = 64): string {
  if (typeof value !== "string") return "unreadable";
  const clean = value.replace(UNSAFE_TEXT_ALL, "�");
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : clean;
}

/** Base units as USDC text, or "unreadable" for anything that is not a decimal (never a throw, never 0). */
export function usdcText(units: string): string {
  return typeof units === "string" && DIGITS.test(units) ? formatUsdc(units) : "unreadable";
}

/** `max_total - spent - reserved`: what the contract still lets through (`OverMandateTotal`). */
export function remainingUnits(
  m: Pick<MandateView, "max_total" | "spent" | "reserved">,
): string | null {
  const parts = [m.max_total, m.spent, m.reserved];
  if (!parts.every((p) => typeof p === "string" && DIGITS.test(p))) return null;
  const left = BigInt(m.max_total) - BigInt(m.spent) - BigInt(m.reserved);
  return (left < 0n ? 0n : left).toString();
}

export interface MandateState {
  key: "active" | "expired" | "revoked" | "exhausted" | "unknown";
  label: string;
  tone: Tone;
  /** Revoke is offered only for a mandate that can still pay: not revoked, not expired, readable. */
  canRevoke: boolean;
}

/**
 * The chain's `status` is active, revoked or exhausted; it never says expired, because expiry is a
 * time. The contract stops spending when `now >= expires_at_ns` (checks.rs), so that is when this says
 * expired, even though the chain still says `active`. Revoked wins over expired. Exhausted keeps its
 * Revoke: a released spend gives its use back, so an exhausted mandate can pay again. A status or time
 * that cannot be read offers nothing.
 */
export function mandateState(
  m: Pick<MandateView, "status" | "expires_at_ns">,
  nowMs: number,
): MandateState {
  const status: string = m.status;
  if (status === "revoked")
    return { key: "revoked", ...mandateStatusView("revoked"), canRevoke: false };
  if (status !== "active" && status !== "exhausted") {
    return {
      key: "unknown",
      tone: "neutral",
      label: safeChainText(status, 39) || "unknown",
      canRevoke: false,
    };
  }
  if (typeof m.expires_at_ns !== "string" || !DIGITS.test(m.expires_at_ns)) {
    return { key: "unknown", tone: "warn", label: "expiry unreadable", canRevoke: false };
  }
  if (BigInt(Math.floor(nowMs)) * NS_PER_MS >= BigInt(m.expires_at_ns)) {
    return { key: "expired", tone: "neutral", label: "expired", canRevoke: false };
  }
  return { key: status, ...mandateStatusView(status), canRevoke: true };
}

export type PayeeView =
  /** A valid account id: safe to build an explorer link from. */
  | { kind: "near"; account: string }
  /** The address matches its chain's format (validate.rs). */
  | { kind: "intents"; chain: "base" | "solana"; address: string }
  /** Anything else, as text already made safe. Never linked. */
  | { kind: "unreadable"; text: string };

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A payee read from the chain, checked before it is shown or linked: an account id must fit the NEAR
 * grammar, an address its chain's format. What does not fit is shown as plain safe text with no link.
 */
export function payeeView(payee: unknown): PayeeView {
  if (typeof payee !== "object" || payee === null) {
    return { kind: "unreadable", text: "unreadable payee" };
  }
  const p = payee as Record<string, unknown>;
  if (p.type === "near") {
    return typeof p.account_id === "string" && isNearAccountId(p.account_id)
      ? { kind: "near", account: p.account_id }
      : { kind: "unreadable", text: safeChainText(p.account_id) };
  }
  if (p.type === "intents" && typeof p.address === "string") {
    if (p.chain === "base" && EVM_ADDRESS.test(p.address)) {
      return { kind: "intents", chain: "base", address: p.address };
    }
    if (p.chain === "solana" && SOLANA_ADDRESS.test(p.address)) {
      return { kind: "intents", chain: "solana", address: p.address };
    }
    return {
      kind: "unreadable",
      text: `${safeChainText(p.chain, 16)}:${safeChainText(p.address)}`,
    };
  }
  return { kind: "unreadable", text: "unreadable payee" };
}

/** `2026-12-31 23:59 UTC` for an expiry in nanoseconds, or "unreadable" (never a throw). */
export function expiryText(ns: string): string {
  if (typeof ns !== "string" || !DIGITS.test(ns)) return "unreadable";
  const date = new Date(Number(BigInt(ns) / NS_PER_MS));
  if (Number.isNaN(date.getTime())) return "unreadable";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The start and end of a purpose sha256 (64 lowercase hex), or "unreadable". */
export function purposeShort(hash: string): string {
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    ? `${hash.slice(0, 8)}…${hash.slice(-6)}`
    : "unreadable";
}
