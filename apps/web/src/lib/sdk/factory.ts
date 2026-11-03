import "server-only";
import { Probarion, type ProbarionDeps, type ProbarionLogger } from "@probarion/sdk";
import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { SupabaseLedgerStore } from "@/lib/ledger/store";
import { log } from "@/lib/log";

export interface TenantProbarionOptions {
  /** `tenant_id` from the session's membership (or a server job's own tenant row), never from a request. */
  tenant: { tenant_id: string; vault_id: string };
  /** "ed25519:<secret>" of the agent key the mandate is bound to (loadActiveSecretFor), or none: read-only. */
  agentKey?: string;
  /** "ed25519:<secret>" of the tenant's ledger key (loadActiveSecret(..., "ledger")). */
  ledgerKey?: string;
  /** Written into every ledger entry this instance writes (SDK v2 `requestId`). */
  requestId: string;
  /** Replaces the proposal persona (the Canary's gullible agent only); it is also added to A8's allow-list. */
  systemPrompt?: string;
}

/** The SDK's warnings, as this app's scrubbed JSON log lines, tagged with the request and the tenant. */
function sdkLogger(o: TenantProbarionOptions): ProbarionLogger {
  return {
    warn: (message, meta) =>
      log.warn("sdk.warn", {
        request_id: o.requestId,
        tenant: o.tenant.tenant_id,
        message,
        ...meta,
      }),
  };
}

/**
 * One Probarion per request, for one tenant, on its Supabase ledger. NEARAI_MODEL passes through; unset means
 * the SDK resolves the default (Decision D8). Without NEARAI_API_KEY the cycle decides rules-only. `deps` is for
 * tests only.
 */
export function makeTenantProbarion(
  o: TenantProbarionOptions,
  deps: ProbarionDeps = {},
): Probarion {
  const env = getEnv();
  return new Probarion(
    {
      network: env.NEAR_NETWORK,
      vault: o.tenant.vault_id,
      agentKey: o.agentKey,
      ledgerKey: o.ledgerKey,
      rpcUrls: env.NEAR_RPC_URLS,
      model: env.NEARAI_API_KEY
        ? {
            provider: "near-ai-cloud",
            apiKey: env.NEARAI_API_KEY,
            ...(env.NEARAI_MODEL ? { model: env.NEARAI_MODEL } : {}),
            ...(o.systemPrompt ? { systemPrompt: o.systemPrompt } : {}), // SDK v2: Canary persona only
          }
        : null,
      ledger: new SupabaseLedgerStore(serviceDb(), o.tenant.tenant_id),
      requestId: o.requestId, // SDK v2: written into every ledger entry
    },
    { logger: sdkLogger(o), ...deps },
  );
}
