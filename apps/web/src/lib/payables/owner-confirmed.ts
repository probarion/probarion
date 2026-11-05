import { createHash } from "node:crypto";
import type { CustomRule, DecisionInput, MandateView, RuleResult } from "@probarion/core";
import { PublicKey } from "near-api-js";
import { nep413Digest } from "@/lib/auth/verify";
import { decodeCanonical } from "@/lib/crypto/sodium";
import { CONFIRM_RECIPIENT } from "./confirm-message";
import { payeeId } from "./payee";

// The owner confirmed (rulings W-T14-R0 and R1). When the vault owner pays an invoice that waited for them, the
// confirm service runs the cycle on a Probarion made WITHOUT custom.owner_confirms_without_model and WITH this rule.
// It passes only when the decision pays exactly what the owner signed for: the amount, the invoice hash, the mandate
// and its payee. Its detail is the whole confirmation (the account, the signer key and the final block at which it
// was read as FullAccess, the nonce, the message's sha256, the full signature and the message itself), so the
// confirmation sits in the signed, hash-chained ledger and an auditor re-verifies it from the ledger alone
// (verifyOwnerConfirmedDetail): sha256(message), then the NEP-413 signature over the message, the nonce and the
// recipient. Whether the key was a FullAccess key of the owner at that block is a question for an archival node.

export const OWNER_CONFIRMED_RULE = "custom.owner_confirmed" as const;

export interface OwnerConfirmation {
  /** The vault's on-chain owner, who signed. */
  account: string;
  /** The signer key (ed25519:<base58>), read as a FullAccess key of `account` at `keyBlockHeight`. */
  publicKey: string;
  /** The 64 signature bytes, standard padded base64. */
  signature: string;
  /** The 32-byte NEP-413 nonce, hex. */
  nonceHex: string;
  /** The exact message the server built and verified the signature over. */
  message: string;
  keyBlockHeight: number;
  keyBlockHash: string;
  /** What the owner signed for: the decision must pay exactly this. */
  amount: string;
  invoiceHash: string;
  mandateId: number;
  /** The mandate's payee, in payeeId form. */
  payee: string;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The rule's detail when it passes: one line, fields in a fixed order, the message last. */
export function ownerConfirmedDetail(c: OwnerConfirmation): string {
  return [
    `owner ${c.account} signed it (NEP-413, recipient ${CONFIRM_RECIPIENT})`,
    `key ${c.publicKey}, FullAccess at final block ${c.keyBlockHeight} ${c.keyBlockHash}`,
    `nonce ${c.nonceHex}`,
    `message sha256 ${sha256(c.message)}`,
    `signature ${c.signature}`,
    `message: ${c.message}`,
  ].join(" | ");
}

/** Why the decision does not pay what the owner signed for, or null when it does. */
function mismatch(
  c: OwnerConfirmation,
  input: DecisionInput,
  chosen: MandateView | null,
): string | null {
  if (input.invoice.amount !== c.amount) {
    return `the decision's amount ${String(input.invoice.amount)} is not the ${c.amount} the owner confirmed`;
  }
  if (input.invoice.invoice_hash !== c.invoiceHash) {
    return "the decision is for another invoice than the one the owner confirmed";
  }
  if (chosen === null) return `no mandate was chosen; the owner confirmed mandate ${c.mandateId}`;
  if (chosen.id !== c.mandateId) {
    return `mandate ${chosen.id} is not mandate ${c.mandateId} the owner confirmed`;
  }
  if (payeeId(chosen.payee) !== c.payee)
    return "the mandate's payee is not the payee the owner confirmed";
  return null;
}

export function ownerConfirmedRule(c: OwnerConfirmation): CustomRule {
  return {
    id: OWNER_CONFIRMED_RULE,
    check(input, chosen): RuleResult {
      const wrong = mismatch(c, input, chosen);
      return wrong === null
        ? { id: OWNER_CONFIRMED_RULE, outcome: "pass", detail: ownerConfirmedDetail(c) }
        : { id: OWNER_CONFIRMED_RULE, outcome: "refuse", detail: `${wrong}: nothing is sent` };
    },
  };
}

const DETAIL =
  /^owner ([a-z0-9._-]{2,64}) signed it \(NEP-413, recipient ([\x21-\x7E]+)\) \| key (ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}), FullAccess at final block ([0-9]{1,18}) ([1-9A-HJ-NP-Za-km-z]{32,44}) \| nonce ([0-9a-f]{64}) \| message sha256 ([0-9a-f]{64}) \| signature ([A-Za-z0-9+/]{86}==) \| message: ([\x20-\x7E]{1,2000})$/;

export interface ParsedConfirmation {
  account: string;
  recipient: string;
  publicKey: string;
  keyBlockHeight: number;
  keyBlockHash: string;
  nonceHex: string;
  messageSha256: string;
  signature: string;
  message: string;
}

/** The fields of a passing custom.owner_confirmed detail, or null for any other text. */
export function parseOwnerConfirmedDetail(detail: string): ParsedConfirmation | null {
  const m = DETAIL.exec(detail);
  if (!m) return null;
  const [
    ,
    account,
    recipient,
    publicKey,
    height,
    keyBlockHash,
    nonceHex,
    messageSha256,
    signature,
    message,
  ] = m as unknown as string[];
  return {
    account: account as string,
    recipient: recipient as string,
    publicKey: publicKey as string,
    keyBlockHeight: Number(height),
    keyBlockHash: keyBlockHash as string,
    nonceHex: nonceHex as string,
    messageSha256: messageSha256 as string,
    signature: signature as string,
    message: message as string,
  };
}

/**
 * What an auditor checks with the ledger entry alone: the detail parses, the message hashes to the recorded sha256,
 * the message names the same owner, and the signature verifies over the NEP-413 payload (message, nonce, recipient)
 * under the recorded key.
 */
export function verifyOwnerConfirmedDetail(
  detail: string,
):
  | { ok: true; account: string; publicKey: string; keyBlockHeight: number }
  | { ok: false; why: string } {
  const p = parseOwnerConfirmedDetail(detail);
  if (p === null) return { ok: false, why: "not a custom.owner_confirmed record" };
  if (p.recipient !== CONFIRM_RECIPIENT) return { ok: false, why: "another recipient" };
  if (sha256(p.message) !== p.messageSha256)
    return { ok: false, why: "the message does not match its sha256" };
  if (!p.message.includes(` | owner ${p.account} | `)) {
    return { ok: false, why: "the message names another owner" };
  }
  if (!p.message.includes(` | nonce ${p.nonceHex} | `)) {
    return { ok: false, why: "the message carries another nonce" };
  }
  const sig = decodeCanonical(p.signature, "base64");
  if (sig === null || sig.length !== 64) return { ok: false, why: "the signature is malformed" };
  let good = false;
  try {
    good = PublicKey.fromString(p.publicKey).verify(
      nep413Digest(p.message, Buffer.from(p.nonceHex, "hex"), p.recipient),
      sig,
    );
  } catch {
    good = false;
  }
  if (!good) return { ok: false, why: "the signature does not verify under the recorded key" };
  return { ok: true, account: p.account, publicKey: p.publicKey, keyBlockHeight: p.keyBlockHeight };
}
