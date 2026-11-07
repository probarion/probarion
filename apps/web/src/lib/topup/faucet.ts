import "server-only";
import { NETWORKS, USDC_DECIMALS } from "@probarion/core";
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
import { json, problem } from "@/lib/http";
import { log } from "@/lib/log";
import { chainConsts, getReader, getRpc } from "@/lib/near/server";
import { LIMITS, type RateDecision, takeToken } from "@/lib/ratelimit";
import { faucetCapText, faucetCopy, faucetUsedText } from "./copy";

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
/** Inside the route's 60 s, with room for the reads before it. */
const BUDGET_MS = 45_000;

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

/** One counter per vault, and one for all vaults together. Both are testnet's: the faucet has no other network. */
export const FAUCET_BUCKETS = {
  vault: (vault: string) => `faucet:testnet:${vault}`,
  global: "faucet:testnet",
};

/**
 * The sender for the faucet key, or null when the value is not a secret key. The message logged names the kind of
 * error, never the value or its text.
 */
export function faucetSender(network: FaucetNetwork, secretKey: string): TxSender | null {
  const deadline = Date.now() + BUDGET_MS;
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

interface Taken {
  decision: RateDecision;
  window: number;
}

/** One hit on `bucket` under `limit` (a `LIMITS` entry), with the window it was taken under. */
async function take(
  db: ReturnType<typeof serviceDb>,
  bucket: string,
  [max, window]: readonly [number, number],
): Promise<Taken> {
  return { decision: await takeToken(db, bucket, max, window), window };
}

/** A 429 that says when to try again: from the database's clock, else (a value that is not a time) the whole window. */
function refused({ decision, window }: Taken, text: (retrySeconds: number) => string): Response {
  const resetMs = new Date(decision.reset_at).getTime();
  const retry = Number.isFinite(resetMs)
    ? Math.max(1, Math.ceil((resetMs - Date.now()) / 1000))
    : window;
  return problem(429, "rate_limited", text(retry), { "Retry-After": String(retry) });
}

/**
 * One hit on the vault's counter, then, only if that one allows it, one on the counter for all vaults, so a vault
 * that clicks again cannot use up the cap of the others. Null when both allow a mint; else the answer: 429, or 503
 * when the limiter cannot be reached (a faucet that cannot count does not mint).
 */
export async function faucetLimited(vault: string): Promise<Response | null> {
  const db = serviceDb();
  try {
    const own = await take(db, FAUCET_BUCKETS.vault(vault), LIMITS.faucetVault);
    if (!own.decision.allowed) return refused(own, faucetUsedText);
    const all = await take(db, FAUCET_BUCKETS.global, LIMITS.faucetGlobal);
    if (!all.decision.allowed) return refused(all, faucetCapText);
    return null;
  } catch (error) {
    log.error("faucet.limiter_failed", { error });
    return problem(503, "unavailable", "Try again in a minute.");
  }
}

/**
 * Signs and sends the mint, once. The answers: 200 minted (with the hash); 502 when the token refused it (for example
 * out of NEAR for a new vault's storage); 503 when the node refused the key or nothing could be sent; 202 when it was
 * sent and its outcome is not known. That one is never sent again: the vault's day is used, and the hash says where
 * to look.
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
