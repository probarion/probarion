import "server-only";
import {
  isOutOfNearCode,
  LACK_BALANCE_CODE,
  NOT_ENOUGH_BALANCE_CODE,
  OUT_OF_NEAR_DETAIL,
} from "@probarion/sdk";

/**
 * R3, with W-T8-R1's scope. The SDK's codes for a chain that refused a transaction as out of NEAR,
 * built on the server (the SDK does not belong in a client bundle) and handed to the client buttons
 * as plain data.
 *
 * Two wordings, by who signed:
 *  - a spend the vault's agent key signs (the SDK cycle, Tasks 13/17): the vault is out of NEAR,
 *    `OUT_OF_NEAR_DETAIL`, through `outOfNearDetail`;
 *  - a call the console asks the owner or an approver to sign: the signer first, then the vault
 *    (`SIGNER_OUT_OF_NEAR` in display.ts, applied by VaultTxButton and CreateVaultPanel).
 */
export interface OutOfNear {
  codes: string[];
  /** For vault-signed SDK spends only. */
  detail: string;
}

export const OUT_OF_NEAR: OutOfNear = {
  codes: [LACK_BALANCE_CODE, NOT_ENOUGH_BALANCE_CODE].filter(isOutOfNearCode),
  detail: OUT_OF_NEAR_DETAIL,
};

/** The SDK's vault wording for an out-of-NEAR code on a vault-signed spend, else null. */
export function outOfNearDetail(code: unknown): string | null {
  return isOutOfNearCode(code) ? OUT_OF_NEAR_DETAIL : null;
}
