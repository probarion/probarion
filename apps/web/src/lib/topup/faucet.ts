import "server-only";
import { type AccessKeyInfo, NETWORKS, USDC_DECIMALS } from "@probarion/core";
import {
  type FunctionCallTx,
  NearApiJsSender,
  type TxOutcome,
  TxOutcomeUnknownError,
  TxRejectedError,
  type TxSender,
} from "@probarion/sdk";
import type { Network } from "@/lib/config";
import { isVaultConfig } from "@/lib/console/vaults";
import { serviceDb } from "@/lib/db/clients";
import { json, problem, rateLimitOr429 } from "@/lib/http";
import { log } from "@/lib/log";
import { chainConsts, getReader, getRpc } from "@/lib/near/server";
import { LIMITS, takeToken } from "@/lib/ratelimit";
import { faucetAccountText, faucetCapText, faucetCopy, faucetUsedText } from "./copy";

// The testnet faucet (audit P0-2): a signed-in owner gets a fixed amount of test USDC minted straight into their
// vault, so a visitor can fund a vault without asking the team. Testnet only, and only ever into a vault: the route
// (app/api/topup/faucet) checks who asks and where; this module holds what is minted, by whom, and how often.

/**
 * The account that signs: the test token's owner (`new` in scripts/testnet/deploy.sh gives `owner_id` as ROOT), the one
 * account whose `mint` the token accepts. Its faucet key is a function-call key for `mint` on the token only.
 */
export const FAUCET_SIGNER = "probarion.testnet";

/** The fixed amount, in whole test USDC. The body of a request never sets it. */
export const FAUCET_USDC = "25";
export const FAUCET_UNITS = (BigInt(FAUCET_USDC) * 10n ** BigInt(USDC_DECIMALS)).toString();

/** What deploy.sh gives the same mint. A first mint into a vault also registers it on the token. */
export const FAUCET_GAS = 30_000_000_000_000n;

/** Each step of the send (signing, the send, a lookup) gets at most this, and all of them together `BUDGET_MS`. */
const STEP_MS = 20_000;
/**
 * The whole request's time on NEAR, inside the route's 60 s. It starts before the reads (faucetDeadline), so slow reads
 * leave the send less time, never more than the route has.
 */
const BUDGET_MS = 45_000;
/** What the send needs left of the budget. With less, the route stops before it counts the mint (faucetLate). */
export const SEND_MIN_MS = 30_000;

/** The least allowance the key may have left, 0.01 NEAR: a few mints. Below it the faucet stops before counting. */
export const MIN_ALLOWANCE = 10n ** 22n;

/** The one network the faucet serves. Its functions take it from the vault the guard found, never as a literal. */
export type FaucetNetwork = Extract<Network, "testnet">;

/** The one transaction the faucet signs: `mint` of the fixed amount to `vault`, on testnet's USDC, with no deposit. */
export function faucetMintTx(vault: string): FunctionCallTx {
  return {
    receiverId: NETWORKS.testnet.usdc,
    methodName: "mint",
    args: { account_id: vault, amount: FAUCET_UNITS },
    gas: FAUCET_GAS,
    deposit: 0n,
  };
}

/** The UTC day a mint counts against, as YYYY-MM-DD. */
export function faucetDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Seconds until the next midnight UTC, when every faucet counter starts again (at least 1). */
export function untilMidnightUtc(now: Date): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

/**
 * One counter per vault, one per owner account, and one for all vaults together, each named for the UTC day, so all of
 * them start again together at midnight UTC. All are testnet's: the faucet has no other network.
 */
export const FAUCET_BUCKETS = {
  vault: (vault: string, day: string) => `faucet:testnet:vault:${vault}:${day}`,
  account: (account: string, day: string) => `faucet:testnet:account:${account}:${day}`,
  global: (day: string) => `faucet:testnet:all:${day}`,
  /** Presses per account in a 10-minute window (`LIMITS.faucetTries`), not per day. */
  tries: (account: string) => `faucet:testnet:tries:${account}`,
};

/** When the request's time on NEAR runs out. The route takes it first, before any read. */
export function faucetDeadline(now = Date.now()): number {
  return now + BUDGET_MS;
}

/**
 * The sender for the faucet key, or null when the value is not a secret key. The message logged names the kind of
 * error, never the value or its text. Each step of the send gets what is left before `deadline`, at most `STEP_MS`.
 */
export function faucetSender(
  network: FaucetNetwork,
  secretKey: string,
  deadline: number,
): TxSender | null {
  try {
    return new NearApiJsSender({
      accountId: FAUCET_SIGNER,
      secretKey,
      rpcUrl: () => getRpc(network).currentUrl,
      sendTimeoutMs: () => Math.min(STEP_MS, deadline - Date.now()),
    });
  } catch (error) {
    log.error("faucet.key_invalid", { error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

/**
 * Null when the chain agrees with the console: `account` is the vault's owner and the vault holds testnet's USDC (test
 * USDC minted to a vault that counts another token would not be money it can spend). Else the answer to send.
 */
export async function faucetVaultRefusal(
  network: FaucetNetwork,
  vault: string,
  account: string,
): Promise<Response | null> {
  const unread = () =>
    problem(
      503,
      "unavailable",
      "The vault could not be read from NEAR, so nothing was minted. Try again.",
    );
  let config: unknown;
  try {
    config = await getReader(network).getConfig(vault);
  } catch (error) {
    log.warn("faucet.config_unreadable", { vault, error });
    return unread();
  }
  if (!isVaultConfig(config)) {
    log.warn("faucet.config_unreadable", { vault, error: "not a vault config" });
    return unread();
  }
  if (config.owner !== account) {
    return problem(
      409,
      "not_owner",
      `The chain names ${config.owner} as this vault's owner, not ${account}, so nothing was minted.`,
    );
  }
  const { usdc } = chainConsts(network);
  if (config.usdc !== usdc) {
    return problem(
      409,
      "wrong_token",
      `This vault's token is ${config.usdc}, not testnet's USDC (${usdc}), so nothing was minted.`,
    );
  }
  return null;
}

/** True for a function-call key that can call `mint` on testnet's USDC and nothing else. */
function mintOnly(key: AccessKeyInfo | null): key is AccessKeyInfo & {
  permission: Exclude<AccessKeyInfo["permission"], "FullAccess">;
} {
  const p = key?.permission;
  return (
    typeof p === "object" &&
    p.receiver_id === NETWORKS.testnet.usdc &&
    p.method_names.length === 1 &&
    p.method_names[0] === "mint"
  );
}

/**
 * Null when the faucet key, as the chain holds it, is a function-call key for `mint` on testnet's USDC alone, with at
 * least `MIN_ALLOWANCE` left. Else the answer to send, before anything is counted: a full-access key, a key for
 * anything more, or a deleted key is not a faucet key (the server never signs with one), and a key out of allowance
 * would only fail at the node after the vault's day was used.
 */
export async function faucetKeyRefusal(
  network: FaucetNetwork,
  publicKey: string,
): Promise<Response | null> {
  const copy = faucetCopy(FAUCET_USDC);
  let key: AccessKeyInfo | null;
  try {
    key = await getRpc(network).viewAccessKey(FAUCET_SIGNER, publicKey);
  } catch (error) {
    log.warn("faucet.key_unreadable", { public_key: publicKey, error });
    return problem(503, "unavailable", copy.unavailable);
  }
  if (!mintOnly(key)) {
    const found =
      key === null ? "missing" : key.permission === "FullAccess" ? "full_access" : "other";
    log.error("faucet.key_not_mint_only", { public_key: publicKey, found });
    return problem(503, "not_configured", copy.unavailable);
  }
  const { allowance } = key.permission;
  if (allowance !== null && (!/^\d+$/.test(allowance) || BigInt(allowance) < MIN_ALLOWANCE)) {
    log.error("faucet.allowance_low", { public_key: publicKey, allowance });
    return problem(503, "unavailable", copy.unavailable);
  }
  return null;
}

/**
 * One hit on the account's counter of presses, before any read of the chain, so one owner cannot make the server read
 * NEAR without end. Null when it allows the press; else a 429, or 503 when the limiter cannot be reached.
 */
export async function faucetThrottled(account: string): Promise<Response | null> {
  try {
    return await rateLimitOr429(serviceDb(), FAUCET_BUCKETS.tries(account), LIMITS.faucetTries);
  } catch (error) {
    log.error("faucet.limiter_failed", { error });
    return problem(503, "unavailable", "Try again in a minute.");
  }
}

/** A 503 when the reads used so much of the budget that the send might not finish; null when enough is left. */
export function faucetLate(deadline: number, now = Date.now()): Response | null {
  if (deadline - now >= SEND_MIN_MS) return null;
  log.warn("faucet.slow_reads", { left_ms: deadline - now });
  return problem(503, "unavailable", faucetCopy(FAUCET_USDC).slow);
}

/** One hit on `bucket` under `limit` (a `LIMITS` entry): true when it is allowed. */
async function take(
  db: ReturnType<typeof serviceDb>,
  bucket: string,
  [max, window]: readonly [number, number],
): Promise<boolean> {
  return (await takeToken(db, bucket, max, window)).allowed;
}

/** A 429 that says when to try again: at midnight UTC, when the day's counters start again. */
function refused(retry: number, text: string): Response {
  return problem(429, "rate_limited", text, { "Retry-After": String(retry) });
}

/**
 * One hit on the vault's counter for the day, then on the owner account's, then on the one for all vaults, each only
 * if the one before allows it: a vault that clicks again uses nothing else, and an account with many vaults stops at
 * its own cap. A refusal comes from a counter used up until midnight UTC, when every counter taken before it starts
 * again too, so those lose nothing: the vault's one owner cannot mint again today either way. Null when all three
 * allow a mint; else the answer: 429, or 503 when the limiter cannot be reached (a faucet that cannot count does not
 * mint).
 */
export async function faucetLimited(
  vault: string,
  account: string,
  now = new Date(),
): Promise<Response | null> {
  const db = serviceDb();
  const day = faucetDay(now);
  const retry = untilMidnightUtc(now);
  try {
    if (!(await take(db, FAUCET_BUCKETS.vault(vault, day), LIMITS.faucetVault))) {
      return refused(retry, faucetUsedText(retry));
    }
    if (!(await take(db, FAUCET_BUCKETS.account(account, day), LIMITS.faucetAccount))) {
      return refused(retry, faucetAccountText(retry, LIMITS.faucetAccount[0]));
    }
    if (!(await take(db, FAUCET_BUCKETS.global(day), LIMITS.faucetGlobal))) {
      return refused(retry, faucetCapText(retry));
    }
    return null;
  } catch (error) {
    log.error("faucet.limiter_failed", { error });
    return problem(503, "unavailable", "Try again in a minute.");
  }
}

/** True when this server's faucet key parses as a secret key: what the page shows the button for (the route's parse). */
export function faucetConfigured(network: FaucetNetwork, key: string | null): boolean {
  return key !== null && faucetSender(network, key, faucetDeadline()) !== null;
}

/**
 * Signs and sends the mint, once. The answers: 200 minted (with the hash); 502 when the token refused it (for example
 * out of NEAR for a new vault's storage); 503 when the node refused the key or nothing could be sent; 202 when it was
 * sent and its outcome is not known. That one is never sent again: the vault's day is used, and the hash says where
 * to look. A send that failed before anything left (TxSendFailed) also keeps the day: the limiter has no give-back,
 * and the runbook's SQL gives a day back by hand.
 */
export async function mintToVault(sender: TxSender, vault: string): Promise<Response> {
  const copy = faucetCopy(FAUCET_USDC);
  let outcome: TxOutcome;
  try {
    outcome = await sender.functionCall(faucetMintTx(vault));
  } catch (error) {
    if (error instanceof TxOutcomeUnknownError) {
      log.warn("faucet.outcome_unknown", { vault, tx_hash: error.txHash });
      return json({ status: "unknown", txHash: error.txHash, detail: copy.unknown }, 202);
    }
    if (error instanceof TxRejectedError) {
      log.error("faucet.refused", { vault, kind: error.kind });
    } else {
      log.error("faucet.send_failed", {
        vault,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    return problem(503, "unavailable", copy.unavailable);
  }
  if (!outcome.ok) {
    log.error("faucet.mint_failed", {
      vault,
      tx_hash: outcome.txHash,
      code: outcome.code,
      failure: outcome.failure?.slice(0, 300) ?? null,
    });
    return json({ error: "mint_failed", detail: copy.unavailable, txHash: outcome.txHash }, 502);
  }
  log.info("faucet.minted", { vault, tx_hash: outcome.txHash, amount: FAUCET_UNITS });
  return json({ status: "minted", txHash: outcome.txHash, amount: FAUCET_USDC });
}
