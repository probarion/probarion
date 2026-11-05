import "server-only";
import type { MandateView } from "@probarion/core";
import { NearAiProposer, NearApiJsSender, type ProbarionDeps, RpcClient } from "@probarion/sdk";
import type { Db } from "@/lib/db/port";
import { getEnv } from "@/lib/env";
import { openKey } from "@/lib/keys/open";
import { loadActiveSecret, loadActiveSecretFor } from "@/lib/keys/service";
import { log } from "@/lib/log";
import { makeTenantProbarion } from "@/lib/sdk/factory";
import { CANARY_LIMITS } from "./limits";
import { CANARY_SYSTEM_PROMPT } from "./prompt";
import { canaryNoAutopay } from "./rules";
import type { CanaryProbarion } from "./service";

/**
 * How long each NEAR AI call may take, by itself. The SDK's own limits (chat 90 s, 10 s, 15 s and 15 s) let one cycle
 * outlive the route's 60 s. These are each phase's own cap: with the attempt's time (below) every call also gets no more
 * than what is left, and all of them together no more than `CANARY_LIMITS.modelBudgetMs`.
 */
export const CANARY_NEARAI_TIMEOUTS_MS = {
  catalog: 6000,
  report: 6000,
  chat: 30_000,
  signature: 6000,
} as const;

/** The time one attempt has left (the service's clock): given to the chain client, the senders and the model calls. */
export interface CanaryBudget {
  remainingMs(): number;
}

// The catalog and the probe that pick the model are the same for every attempt, so a warm process keeps the model its first
// attempt resolved for ten minutes. The attestation report for each request's nonce is NOT cached (the nonce is the point).
let knownModel: { model: string; at: number } | null = null;

/** Forgets the model kept for later attempts (for tests). */
export function resetCanaryModelCache(): void {
  knownModel = null;
}

function cachedModel(): string | undefined {
  if (knownModel === null || Date.now() - knownModel.at >= CANARY_LIMITS.modelCacheMs) {
    return undefined;
  }
  return knownModel.model;
}

/** The proposer for the Canary's persona with those timeouts, or null without a NEAR AI key. */
function canaryProposer(budget: CanaryBudget | undefined): NearAiProposer | null {
  const env = getEnv();
  if (!env.NEARAI_API_KEY) return null;
  // ALL the model calls of one attempt share `modelBudgetMs`, counted from the first call, and never more than the attempt
  // has left.
  let startedAt: number | null = null;
  const remainingMs =
    budget === undefined
      ? undefined
      : () => {
          startedAt ??= Date.now();
          return Math.min(
            CANARY_LIMITS.modelBudgetMs - (Date.now() - startedAt),
            budget.remainingMs(),
          );
        };
  const known = cachedModel();
  return new NearAiProposer({
    apiKey: env.NEARAI_API_KEY,
    ...(env.NEARAI_MODEL ? { model: env.NEARAI_MODEL } : {}),
    ...(known === undefined ? {} : { knownModel: known }),
    systemPrompt: CANARY_SYSTEM_PROMPT,
    timeoutMs: CANARY_NEARAI_TIMEOUTS_MS,
    // the SDK waits for the signature with back-off between tries (0.4 s, 0.8 s, ...): two tries are enough here
    signatureRetries: 2,
    ...(remainingMs === undefined ? {} : { remainingMs }),
  });
}

/**
 * The SDK instance for one Canary attempt: signing with the agent key `mandate` is bound to and the tenant's ledger key,
 * with the Canary's gullible persona, a NEAR AI proposer with bounded timeouts, and the rule that the Canary never pays
 * from its own cycle (rules.ts). The mandate decides the key (`loadActiveSecretFor(..., mandate.agent_pk)`): there is no
 * fallback to any other agent key. A key that is not active here, cannot be opened or does not match its public key gives
 * null ("not ready"), is logged without any key material, and is never retried; so does a missing NEAR AI key, because a
 * Canary with no model has nothing to fool.
 *
 * `budget` is the time the attempt has left. Given, every phase shares it: the chain client stops when it is over, the two
 * senders take the smaller of `chainStepTimeoutMs` and what is left for each step, and the proposer's calls share
 * `modelBudgetMs`. Without it the SDK's own defaults apply (tests that do not care). `deps` is for tests (an offline
 * proposer, a fixed clock); a `proposer` given there replaces the NEAR AI one.
 *
 * This is one of the server cycles that may open a sealed secret (like the Payables pipeline); no page or route does.
 */
export async function makeCanaryProbarion(
  db: Db,
  master: Uint8Array,
  tenant: { tenant_id: string; vault_id: string },
  mandate: MandateView,
  requestId: string,
  deps: ProbarionDeps = {},
  budget?: CanaryBudget,
): Promise<CanaryProbarion | null> {
  const ledger = await openKey(() => loadActiveSecret(db, master, tenant.tenant_id, "ledger"));
  const agent = await openKey(() =>
    loadActiveSecretFor(db, master, tenant.tenant_id, mandate.agent_pk),
  );
  const unusable = (purpose: "ledger" | "agent", reason: string) => {
    log.error("canary.key_unavailable", {
      request_id: requestId,
      tenant: tenant.tenant_id,
      mandate_id: mandate.id,
      key_purpose: purpose,
      reason,
    });
    return null;
  };
  if ("problem" in ledger) return unusable("ledger", ledger.problem);
  if ("problem" in agent) return unusable("agent", agent.problem);
  const own = deps.proposer === undefined;
  const proposer = own ? canaryProposer(budget) : deps.proposer;
  if (proposer === null) return null;

  // The chain: with the attempt's time, a client that stops when it is over, and senders that wait at most one step (or
  // what is left) each.
  const chain: ProbarionDeps = {};
  if (budget !== undefined) {
    const rpc =
      deps.rpc ??
      new RpcClient({
        urls: getEnv().NEAR_RPC_URLS,
        maxRounds: 2,
        timeoutMs: CANARY_LIMITS.chainStepTimeoutMs,
        remainingMs: budget.remainingMs,
      });
    const step = () => Math.min(CANARY_LIMITS.chainStepTimeoutMs, budget.remainingMs());
    const sender = (secretKey: string) =>
      new NearApiJsSender({
        accountId: tenant.vault_id,
        secretKey,
        rpcUrl: () => rpc.currentUrl,
        sendTimeoutMs: step,
      });
    chain.rpc = rpc;
    chain.agentSender = deps.agentSender ?? sender(agent.key.secret);
    chain.ledgerSender = deps.ledgerSender ?? sender(ledger.key.secret);
  }

  const pb = makeTenantProbarion(
    {
      tenant,
      agentKey: agent.key.secret,
      ledgerKey: ledger.key.secret,
      requestId,
      systemPrompt: CANARY_SYSTEM_PROMPT,
    },
    { proposer, ...chain, ...deps },
  );
  pb.rules.add(canaryNoAutopay);
  if (!own) return pb;
  // What the proposer resolved while the cycle ran (even if the cycle then failed) is kept for the next attempts.
  const mine = proposer as NearAiProposer;
  return {
    process: async (i) => {
      try {
        return await pb.process(i);
      } finally {
        const model = mine.resolvedModel;
        if (model !== null) knownModel = { model, at: Date.now() };
      }
    },
    checkSpend: (i) => pb.checkSpend(i),
    requestSpend: (i) => pb.requestSpend(i),
  };
}
