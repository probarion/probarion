import { isNearAccountId, type Payee } from "@probarion/core";
import { AUTH_RECIPIENT, type Network } from "@/lib/config";
import { AMOUNT, HEX32, UUID } from "./forms";
import { usdcFixed } from "./view";

// The message the vault owner signs to pay an invoice that waits for them (rulings W-T14-R0 and R1). The server
// builds it from database and chain values only (the nonce's row snapshot, the mandate's payee, the vault's on-chain
// owner) and verifies the signature over its own copy: a message string from the browser is never read. No string
// the invoice text could influence enters it. Every field passes a strict ASCII form first, and the fields a person
// must read come first, so a wallet that cuts a long message still shows them.

/**
 * The NEP-413 recipient of a confirmation. It differs from sign-in's (AUTH_RECIPIENT), so a sign-in signature never
 * verifies as a confirmation and a confirmation never verifies as a sign-in.
 */
export const CONFIRM_RECIPIENT = `${AUTH_RECIPIENT}/payables/confirm`;

/** A confirmation nonce: 32 random bytes, issued by the server for one row snapshot (migration 0007). */
export const CONFIRM_NONCE_BYTES = 32;

export interface ConfirmFields {
  /** USDC base units (6 decimals), the row's suggested_amount. */
  amount: string;
  /** The mandate's payee, read from the chain. */
  payee: Payee;
  vault: string;
  network: Network;
  /** The vault's owner account, read from the chain (get_config). */
  owner: string;
  mandateId: number;
  invoiceId: string;
  invoiceHash: string;
  nonceHex: string;
  /** ISO-8601 UTC to the second, as the database issued it. */
  expiresAt: string;
}

/** A field that does not have its strict form: no message is built, so nothing can be signed. */
export class ConfirmMessageError extends Error {
  constructor(readonly field: string) {
    super(`the confirmation's ${field} is not in its strict form`);
    this.name = "ConfirmMessageError";
  }
}

const ACCOUNT = /^[a-z0-9._-]{2,64}$/;
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PRINTABLE = /^[\x20-\x7E]+$/;

function account(value: unknown, field: string): string {
  if (typeof value !== "string" || !ACCOUNT.test(value) || !isNearAccountId(value)) {
    throw new ConfirmMessageError(field);
  }
  return value;
}

function matching(value: unknown, re: RegExp, field: string): string {
  if (typeof value !== "string" || !re.test(value)) throw new ConfirmMessageError(field);
  return value;
}

/** The mandate's payee as the message names it: `near:<account>`, or `<chain>:<address> (asset <token account>)`. */
export function payeeText(p: Payee): string {
  if (p?.type === "near") return `near:${account(p.account_id, "payee")}`;
  if (p?.type === "intents") {
    const address =
      p.chain === "base"
        ? matching(p.address, EVM_ADDRESS, "payee address")
        : p.chain === "solana"
          ? matching(p.address, SOLANA_ADDRESS, "payee address")
          : null;
    if (address === null) throw new ConfirmMessageError("payee chain");
    return `${p.chain}:${address} (asset ${account(p.asset, "payee asset")})`;
  }
  throw new ConfirmMessageError("payee");
}

/** The exact text the owner signs. Throws ConfirmMessageError rather than build a message from a doubtful field. */
export function confirmMessage(f: ConfirmFields): string {
  const amount = matching(f.amount, AMOUNT, "amount");
  if (f.network !== "mainnet" && f.network !== "testnet") throw new ConfirmMessageError("network");
  if (!Number.isSafeInteger(f.mandateId) || f.mandateId <= 0)
    throw new ConfirmMessageError("mandate");
  const message = [
    "Probarion confirm v1",
    `pay ${usdcFixed(amount)} USDC (${amount} base units) to ${payeeText(f.payee)}`,
    `vault ${account(f.vault, "vault")} (${f.network})`,
    `owner ${account(f.owner, "owner")}`,
    `mandate ${f.mandateId}`,
    `invoice ${matching(f.invoiceId, UUID, "invoice id")}`,
    `sha256 ${matching(f.invoiceHash, HEX32, "invoice hash")}`,
    `nonce ${matching(f.nonceHex, HEX32, "nonce")}`,
    `expires ${matching(f.expiresAt, ISO_SECOND, "expiry")}`,
  ].join(" | ");
  if (!PRINTABLE.test(message)) throw new ConfirmMessageError("message");
  return message;
}

const MESSAGE =
  /^Probarion confirm v1 \| pay ([0-9]+\.[0-9]{6}) USDC \(([1-9][0-9]{0,38}) base units\) to ([\x20-\x7E]+?) \| vault ([a-z0-9._-]{2,64}) \((mainnet|testnet)\) \| owner ([a-z0-9._-]{2,64}) \| mandate ([1-9][0-9]{0,15}) \| invoice ([0-9a-f-]{36}) \| sha256 ([0-9a-f]{64}) \| nonce ([0-9a-f]{64}) \| expires ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)$/;

/** The fields of a confirmation message, for an auditor comparing it with its decision. */
export interface ParsedConfirmMessage {
  amount: string;
  /** As the message writes it (payeeText). */
  payee: string;
  vault: string;
  network: Network;
  owner: string;
  mandateId: number;
  invoiceId: string;
  invoiceHash: string;
  nonceHex: string;
  expiresAt: string;
}

/** A message in the v1 form, or null: another text, or two amounts that disagree. */
export function parseConfirmMessage(message: string): ParsedConfirmMessage | null {
  const m = MESSAGE.exec(message);
  if (!m) return null;
  const [, fixed, amount, payee, vault, network, owner, mandate, invoiceId, hash, nonce, expires] =
    m as unknown as string[];
  if (usdcFixed(amount as string) !== fixed || !UUID.test(invoiceId as string)) return null;
  return {
    amount: amount as string,
    payee: payee as string,
    vault: vault as string,
    network: network as Network,
    owner: owner as string,
    mandateId: Number(mandate),
    invoiceId: invoiceId as string,
    invoiceHash: hash as string,
    nonceHex: nonce as string,
    expiresAt: expires as string,
  };
}
