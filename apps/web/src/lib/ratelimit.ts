import type { Db } from "@/lib/db/port";

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  reset_at: string;
}

/**
 * The longest a rate-limit window may be, in seconds. The daily cron deletes the rows of the limiter that began more than
 * this long ago (rate_limits_prune, migration 0009), which is safe only because no window is longer: a row that old
 * belongs to a window that is over. ratelimit.test.ts holds every window to it.
 */
export const RATE_LIMIT_KEEP_S = 86_400;

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
  /** The public confirmation page and its button (per address); the stop link has none: a valid token is all it needs. */
  alertLink: [30, 60],
  /** Confirmation emails to one address, from every vault together: 3 a day (a day is the longest a window may be). */
  alertConfirmAddress: [3, 86_400],
  /** The console's server actions that read the chain for a signed-in account (lib/near/confirm-action.ts). */
  confirmPerAccount: [30, 60],
  /** All accounts together, on top of the per-account cap. */
  confirmGlobal: [300, 60],
  /** Register (app/console/actions.ts), per account and network: each attempt reads the chain and the membership. */
  registerPerAccount: [10, 600],
  /** The extension's pairing-code exchange (app/api/ext/pair), per address and network: 40-bit codes, 10 minutes each. */
  extPairPerIp: [10, 600],
  /** The same, all addresses together, per network. */
  extPairGlobal: [300, 600],
  /** The extension's inbox (app/api/ext/inbox), per account and network: a popup open or a 5-minute badge read. */
  extInbox: [60, 60],
  /** Invoices the extension queues (app/api/ext/invoices), per account and network. */
  extInvoice: [20, 600],
  /** Tokens and pairing codes the /extension page makes, together, per account and network. */
  extMint: [10, 600],
  /**
   * The testnet faucet (app/api/topup/faucet): one mint of test USDC per vault a day. Its counters are named for the
   * UTC day (lib/topup/faucet.ts), so the window only has to outlast the day.
   */
  faucetVault: [1, 86_400],
  /** The same, per signed-in owner account: one account with many vaults cannot use up the cap for all of them. */
  faucetAccount: [3, 86_400],
  /**
   * The same, all vaults together. It bounds what the faucet costs: each new vault takes 0.00125 NEAR of the test
   * token's own storage, and each mint about 0.003 NEAR of the key's allowance.
   */
  faucetGlobal: [50, 86_400],
  /** Presses of the faucet button per signed-in account, before the chain is read: bounds the reads it causes. */
  faucetTries: [10, 600],
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
