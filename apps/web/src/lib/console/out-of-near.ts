import "server-only";
import {
  isOutOfNearCode,
  LACK_BALANCE_CODE,
  NOT_ENOUGH_BALANCE_CODE,
  OUT_OF_NEAR_DETAIL,
} from "@probarion/sdk";

/**
 * R3: an outcome whose code says the vault is out of NEAR is shown with the SDK's own wording and a
 * top-up. Built on the server (the SDK does not belong in a client bundle) and handed to the client
 * buttons as plain data.
 */
export interface OutOfNear {
  codes: string[];
  detail: string;
}

export const OUT_OF_NEAR: OutOfNear = {
  codes: [LACK_BALANCE_CODE, NOT_ENOUGH_BALANCE_CODE].filter(isOutOfNearCode),
  detail: OUT_OF_NEAR_DETAIL,
};

/** The SDK's text for an out-of-NEAR code, else null. */
export function outOfNearDetail(code: unknown): string | null {
  return isOutOfNearCode(code) ? OUT_OF_NEAR_DETAIL : null;
}
