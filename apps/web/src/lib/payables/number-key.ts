import { createHmac, hkdfSync } from "node:crypto";
import type { Payee } from "@probarion/core";
import { numberKeyText } from "./facts";
import { payeeId } from "./payee";

/** The HKDF label of the invoice-number key: a key of its own, derived from KEY_ENCRYPTION_SECRET. */
const NUMBER_KEY_INFO = "probarion/payables/invoice-number-key/v1";

/**
 * The duplicate guard's second key: HMAC-SHA256, under a server-side key derived from the master key with HKDF, of
 * the vault, the mandate's payee and the invoice number (its skeleton, so case and look-alikes do not matter).
 * Keyed, so the zero-retention mode keeps nothing a member could enumerate back to the number; scoped by payee, so
 * two vendors' "#1001" do not block each other. The console upload and the extension's queue compute it the same
 * way, so each one blocks the other's copy of an invoice.
 */
export function invoiceNumberKey(
  master: Uint8Array,
  vault: string,
  payee: Payee,
  invoiceNumber: string,
): string {
  const key = Buffer.from(hkdfSync("sha256", master, new Uint8Array(0), NUMBER_KEY_INFO, 32));
  return createHmac("sha256", key)
    .update(`${vault}\n${payeeId(payee)}\n${numberKeyText(invoiceNumber)}`)
    .digest("hex");
}
