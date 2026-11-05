import type { Db } from "@/lib/db/port";

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  reset_at: string;
}

/** [max hits, window seconds] per public endpoint. Canary on-chain limits live in canary/limits.ts. */
export const LIMITS = {
  authChallenge: [20, 60],
  authVerify: [10, 60],
  snapshot: [30, 60],
  proofPage: [60, 60],
  topupQuote: [10, 60],
  topupStatus: [30, 60],
  topupSubmit: [10, 60],
  invoiceUpload: [30, 3600],
  canaryModelVisitor: [5, 600],
  canaryModelGlobal: [300, 3600],
  telegramWebhook: [120, 60],
  alertTest: [5, 600],
} as const satisfies Record<string, readonly [number, number]>;

/**
 * One hit on `bucket` (at most 200 characters). Also the nonce burn (R8): `takeToken(db, "auth:nonce:<hex>", 1, 600)`
 * is allowed once and refused on every replay.
 */
export function takeToken(
  db: Db,
  bucket: string,
  max: number,
  windowSeconds: number,
): Promise<RateDecision> {
  return db.rpc<RateDecision>("rate_limit_take", { bucket, max, window_seconds: windowSeconds });
}
