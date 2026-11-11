import "server-only";
import {
  NearAiProposer,
  type NearAiProposerOptions,
  NearApiJsSender,
  type Probarion,
  type ProbarionDeps,
  RpcClient,
  resolveRpcUrls,
  type TxSender,
} from "@probarion/sdk";
import type { Network } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { makeTenantProbarion, type TenantProbarionOptions } from "@/lib/sdk/factory";
import { PAYABLES_NEARAI_TIMEOUTS_MS, type PayablesBudget } from "./budget";

/**
 * `sender` as it is, with one addition: it says when it starts a transaction (`functionCall`), before it signs anything.
 * The key, the steps, their timeouts and the lookups are the wrapped sender's own.
 */
export function announcing(sender: TxSender, sending: () => void): TxSender {
  const lookup = sender.lookup?.bind(sender);
  return {
    accountId: sender.accountId,
    publicKey: sender.publicKey,
    functionCall: (tx) => {
      sending();
      return sender.functionCall(tx);
    },
    ...(lookup === undefined ? {} : { lookup }),
  };
}

/** For tests only: the SDK's own deps (they win over the ones built here) and the NEAR AI transport. */
export interface PayablesProbarionTest {
  deps?: ProbarionDeps;
  nearai?: Pick<NearAiProposerOptions, "baseUrl" | "fetch" | "now" | "sleep">;
}

/**
 * The SDK instance for one console upload: makeTenantProbarion's, with the cycle's time (lib/payables/budget.ts) given to
 * the parts that run before the first transaction.
 *
 * - The model: a NEAR AI proposer like the SDK's own (the same key, model and prompt), whose calls each get their
 *   PAYABLES_NEARAI_TIMEOUTS_MS cap, no more than what `budget.modelMs` says is left. A model that runs out decides
 *   rules-only, so the invoice waits for the owner and nothing is sent.
 * - The chain: an RPC client like the SDK's own (the network's list, the SDK's per-try timeout and rounds), whose reads
 *   stop at `budget.chainMs`. A read refused for lack of time comes before any transaction, so nothing is sent, and it
 *   ends the cycle one of three ways. A context read (the config, the mandates, the spends) or the `check_spend` dry run
 *   throws, and the pipeline records the invoice as `error`, which a new upload may run again. The POA balance read of
 *   an Intents payee is caught by the SDK, and the decision holds on `intents.balance_low`. An anchor's read is caught by
 *   the SDK too, and the cycle ends without an anchor (the next cycle anchors the tail).
 * - The senders: the SDK's own NearApiJsSender, built as the SDK builds it, each wrapped by `announcing`. The first
 *   transaction of either key (the spend, or the anchor of a decision that sends no spend) lifts the read limit, so from
 *   the first transaction on nothing runs differently from the SDK's defaults: the send timing is not touched.
 *
 * Without NEARAI_API_KEY no proposer is made and the cycle decides rules-only, as before.
 */
export function makePayablesProbarion(
  network: Network,
  o: TenantProbarionOptions,
  budget: PayablesBudget,
  test: PayablesProbarionTest = {},
): Probarion {
  const env = getEnv();
  // The URLs the SDK would pick itself from what makeTenantProbarion gives it (the network's list, no environment).
  const rpc = new RpcClient({
    urls: resolveRpcUrls(network, env.networks[network].rpcUrls, {}),
    remainingMs: budget.chainMs,
  });
  const sender = (secretKey: string | undefined): TxSender | undefined =>
    secretKey === undefined || secretKey.trim() === ""
      ? undefined
      : announcing(
          new NearApiJsSender({
            accountId: o.tenant.vault_id,
            secretKey,
            rpcUrl: () => rpc.currentUrl,
          }),
          budget.sending,
        );
  const agentSender = sender(o.agentKey);
  const ledgerSender = sender(o.ledgerKey);
  const proposer = env.NEARAI_API_KEY
    ? new NearAiProposer({
        apiKey: env.NEARAI_API_KEY,
        ...(env.NEARAI_MODEL ? { model: env.NEARAI_MODEL } : {}),
        ...(o.systemPrompt ? { systemPrompt: o.systemPrompt } : {}),
        timeoutMs: PAYABLES_NEARAI_TIMEOUTS_MS,
        remainingMs: budget.modelMs,
        ...test.nearai,
      })
    : null;
  return makeTenantProbarion(network, o, {
    rpc,
    ...(agentSender === undefined ? {} : { agentSender }),
    ...(ledgerSender === undefined ? {} : { ledgerSender }),
    ...(proposer === null ? {} : { proposer }),
    ...test.deps,
  });
}
