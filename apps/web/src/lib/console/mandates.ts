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
 * for a contract rule):
 *  - a mixed-case Base address must be a valid EIP-55 checksum, and the zero address is refused
 *    (parseBaseAddress);
 *  - the label is not empty and has no control character, no line break, no lone surrogate and no
 *    FORMAT character (\p{Cf}): that bars direction marks and overrides and the zero-width space, and also
 *    the zero-width joiner and non-joiner, so a label cannot hold an emoji ZWJ sequence (a family or a
 *    skin-tone emoji) or text that needs ZWNJ (some Persian and Indic words). It is a label, not prose;
 *  - `max_uses` is at most 10,000 and the expiry at most 366 days ahead during the beta;
 *  - the expiry is at least ONE HOUR from now (the contract only needs it to be in the future), so a
 *    date chosen near midnight, or a slow wallet, cannot make the call fail on chain after it was signed;
 *  - a NEAR payee may not be this vault's USDC, its Intents contract or one of its allowed POA asset
 *    contracts (a token contract is not a payee: what is sent there is lost);
 *  - the agent key must be one of the vault's active agent keys (the contract does not check it at
 *    creation, but a mandate for a key that cannot spend is useless).
 *
 * Warnings that do not block (nearPayeeWarnings, floatWarning, backstopWarning): a `0x` address typed as a
 * NEAR account, a NEAR account that does not exist yet, a cap above the vault's balance or its daily backstop.
 *
 * The console offers NEAR and Base payees. The contract also knows Solana; it is not offered here.
 */
import { DIGITS, UNSAFE_TEXT } from "@/lib/console/mandates-view";
import type { MandateInputJson } from "@/lib/near/tx";
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
  /**
   * Accounts that are contracts of this vault's money, not people: its USDC token, its Intents contract
   * and every allowed POA asset (from get_config()). A NEAR payee may not be one of them.
   */
  protocolAccounts: readonly string[];
}

/** The form as it starts, and as it starts again after a confirmed create. Nothing here can be signed as it is. */
export function blankForm(firstAgent: string): MandateForm {
  return {
    payeeKind: "near",
    payee: "",
    purposeHash: "",
    maxPerPaymentUsdc: "100",
    maxTotalUsdc: "1000",
    maxUses: "10",
    expiresOn: "",
    approvalAboveUsdc: "100",
    agentPk: firstAgent,
    label: "",
  };
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
/** Not the contract's rule (it needs only "in the future"): room for the owner to sign before it passes. */
export const MIN_EXPIRY_AHEAD_MS = 3600_000;

const U64_MAX = 2n ** 64n - 1n;
const NS_PER_MS = 1_000_000n;

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
    } else if (ctx.protocolAccounts.includes(rawPayee)) {
      errors.payee =
        "That is a token or bridge contract of this vault (USDC, Intents or a POA asset), not a payee: what is sent there is lost";
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
    else if (expires - nowNs < BigInt(MIN_EXPIRY_AHEAD_MS) * NS_PER_MS) {
      errors.expiresOn =
        "Expiry must be at least one hour from now, so there is time to sign before it passes";
    } else if (expires - nowNs > BigInt(MAX_EXPIRY_AHEAD_MS) * NS_PER_MS) {
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

/**
 * A vault balance that was read (base units), or one that could not be. Never a stand-in zero.
 * `notAllowed` says the vault does not allow the asset at all (so there is no balance to read), which is
 * not the same as a failed read.
 */
export type FloatRead = { ok: true; units: string } | { ok: false; notAllowed?: boolean };

/**
 * A balance read as the console's `Read` records it, as a FloatRead. A read that failed because the vault
 * does not allow the asset (`not_allowed`) is said so; every other failure is just a failed read. Never a zero.
 */
export function floatFromRead(
  r: { ok: true; value: string } | { ok: false; kind: string },
): FloatRead {
  if (r.ok) return { ok: true, units: r.value };
  return r.kind === "not_allowed" ? { ok: false, notAllowed: true } : { ok: false };
}

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
  if (!a.float.ok && a.float.notAllowed === true) {
    return "This vault does not allow Base USDC payouts, so a Base payee cannot be paid from it.";
  }
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

// ---- warnings about a NEAR payee that do not block ------------------------------------------------

/** What the console knows about whether the typed NEAR account exists: not asked yet, asked, or could not be asked. */
export type PayeeExists = boolean | "unreadable" | null;

export const ETH_IMPLICIT_WARNING =
  "This is a 0x address typed as a NEAR account. On NEAR it is an ETH-implicit account, not a Base payout. To pay an address on Base, choose Base address.";
export const MISSING_ACCOUNT_WARNING =
  "No account with this name exists on NEAR yet. If the name is a typo, the USDC would sit with an account nobody controls until someone creates that name.";
export const UNCHECKED_ACCOUNT_NOTE = "The console could not check whether this account exists.";

const EVM_SHAPED = /^0x[0-9a-fA-F]{40}$/;
const IMPLICIT_64 = /^[0-9a-f]{64}$/;

/**
 * An implicit account: 64 hex, or the `0x` + 40 hex (ETH-implicit) form. It does not exist on chain until
 * it is funded, so asking whether it exists tells nothing, and nearPayeeWarnings already decides these.
 */
export function isImplicitAccount(name: string): boolean {
  return IMPLICIT_64.test(name) || EVM_SHAPED.test(name);
}

/**
 * The NEAR account the console asks the chain about for a payee field, or null when it asks nothing: a
 * Base payee, text that is not an account id, and every implicit account.
 */
export function payeeToCheck(payeeKind: "near" | "base", payee: string): string | null {
  if (payeeKind !== "near") return null;
  const name = payee.trim();
  return isNearAccountId(name) && !isImplicitAccount(name) ? name : null;
}

/**
 * Notes under a NEAR payee. A `0x` + 40 hex string is valid as a NEAR account id (an ETH-implicit
 * account) but is almost always meant as a Base address, so it is called out. A named account that does
 * not exist yet is called out too; implicit accounts (64 hex, or the `0x` form) do not exist until they
 * are funded, so they get no such note. Neither blocks: the vault accepts both.
 */
export function nearPayeeWarnings(a: {
  payeeKind: "near" | "base";
  payee: string;
  exists: PayeeExists;
}): string[] {
  if (a.payeeKind !== "near") return [];
  const payee = a.payee.trim();
  if (EVM_SHAPED.test(payee)) return [ETH_IMPLICIT_WARNING];
  if (!isNearAccountId(payee) || isImplicitAccount(payee)) return [];
  if (a.exists === false) return [MISSING_ACCOUNT_WARNING];
  if (a.exists === "unreadable") return [UNCHECKED_ACCOUNT_NOTE];
  return [];
}
