import "server-only";
import type { MandateView } from "@probarion/core";
import type { Db } from "@/lib/db/port";
import { openKey } from "@/lib/keys/open";
import { loadActiveSecret, loadActiveSecretFor } from "@/lib/keys/service";
import { log } from "@/lib/log";
import { makeTenantProbarion } from "@/lib/sdk/factory";
import { CANARY_SYSTEM_PROMPT } from "./prompt";
import type { CanaryProbarion } from "./service";

/**
 * The SDK instance for one Canary attempt: signing with the agent key `mandate` is bound to and the tenant's ledger key,
 * with the Canary's gullible persona. The mandate decides the key (`loadActiveSecretFor(..., mandate.agent_pk)`): there is
 * no fallback to any other agent key. A key that is not active here, cannot be opened or does not match its public key
 * gives null ("not ready"), is logged without any key material, and is never retried.
 *
 * This is one of the server cycles that may open a sealed secret (like the Payables pipeline); no page or route does.
 */
export async function makeCanaryProbarion(
  db: Db,
  master: Uint8Array,
  tenant: { tenant_id: string; vault_id: string },
  mandate: MandateView,
  requestId: string,
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
  return makeTenantProbarion({
    tenant,
    agentKey: agent.key.secret,
    ledgerKey: ledger.key.secret,
    requestId,
    systemPrompt: CANARY_SYSTEM_PROMPT,
  });
}
