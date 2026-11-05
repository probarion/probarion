import "server-only";
import type { MandateView } from "@probarion/core";
import { NearAiProposer, type ProbarionDeps } from "@probarion/sdk";
import type { Db } from "@/lib/db/port";
import { getEnv } from "@/lib/env";
import { openKey } from "@/lib/keys/open";
import { loadActiveSecret, loadActiveSecretFor } from "@/lib/keys/service";
import { log } from "@/lib/log";
import { makeTenantProbarion } from "@/lib/sdk/factory";
import { CANARY_SYSTEM_PROMPT } from "./prompt";
import { canaryNoAutopay } from "./rules";
import type { CanaryProbarion } from "./service";

/**
 * How long each NEAR AI call may take. The SDK's own limits (chat 90 s, 10 s, 15 s and 15 s) let one cycle outlive the
 * route's 60 s, and a function the platform kills leaves the tenant's lease held. With these, a cycle's model work ends
 * well inside 60 s: the chat is the one long call, every other phase is at most 6 s.
 */
export const CANARY_NEARAI_TIMEOUTS_MS = {
  catalog: 6000,
  report: 6000,
  chat: 30_000,
  signature: 6000,
} as const;

/** The proposer for the Canary's persona with those timeouts, or null without a NEAR AI key. */
function canaryProposer(): NearAiProposer | null {
  const env = getEnv();
  if (!env.NEARAI_API_KEY) return null;
  return new NearAiProposer({
    apiKey: env.NEARAI_API_KEY,
    ...(env.NEARAI_MODEL ? { model: env.NEARAI_MODEL } : {}),
    systemPrompt: CANARY_SYSTEM_PROMPT,
    timeoutMs: CANARY_NEARAI_TIMEOUTS_MS,
    // the SDK waits for the signature with back-off between tries (0.4 s, 0.8 s, ...): two tries are enough here
    signatureRetries: 2,
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
 * `deps` is for tests (an offline proposer, a fixed clock); a `proposer` given there replaces the NEAR AI one.
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
  const proposer = deps.proposer !== undefined ? deps.proposer : canaryProposer();
  if (proposer === null) return null;
  const pb = makeTenantProbarion(
    {
      tenant,
      agentKey: agent.key.secret,
      ledgerKey: ledger.key.secret,
      requestId,
      systemPrompt: CANARY_SYSTEM_PROMPT,
    },
    { proposer, ...deps },
  );
  pb.rules.add(canaryNoAutopay);
  return pb;
}
