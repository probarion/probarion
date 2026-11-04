import "server-only";
import { getSession } from "@/lib/auth/guard";
import { publicDb, serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { getRpc } from "@/lib/near/server";
import proofEvidence from "../../../content/proof-evidence.json";
import { evidenceFor } from "./evidence";
import { makeProofReader } from "./reader";
import type { ProofDeps } from "./service";

/**
 * What /proof and snapshot.json run on (ruling W-T16-R0: here, not in lib/sdk). The reader is a read-only Probarion:
 * no agent or ledger key, no model (interfaces v2 §9). Every verifier dependency is explicit (R5): the archival RPC
 * from NEAR_ARCHIVAL_RPC_URLS, and this vault's entry of content/proof-evidence.json, which is bundled at build time
 * and checked on every read, so a malformed file shows an error state instead of a result.
 */
export async function proofDeps(): Promise<ProofDeps> {
  const env = getEnv();
  const session = await getSession();
  return {
    network: env.NEAR_NETWORK,
    publicDb: publicDb(),
    serviceDb: serviceDb(),
    sessionAccount: session?.accountId ?? null,
    makeReader: (vault, store) =>
      makeProofReader({
        network: env.NEAR_NETWORK,
        vault,
        store,
        rpc: getRpc(),
        archivalRpcUrls: env.NEAR_ARCHIVAL_RPC_URLS,
        evidence: evidenceFor(proofEvidence, env.NEAR_NETWORK, vault),
      }),
  };
}
