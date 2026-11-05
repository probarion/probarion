import type { Payee } from "@probarion/core";

/**
 * The payee as one lower-case string: a NEAR account, or an Intents chain, address and asset. The duplicate guard's
 * invoice-number key (pipeline.ts) and the console's "same payee" list compare payees in this one form.
 */
export const payeeId = (p: Payee): string =>
  (p.type === "near"
    ? `near:${p.account_id}`
    : `intents:${p.chain}:${p.address}:${p.asset}`
  ).toLowerCase();
