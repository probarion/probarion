import "server-only";
import { getSession } from "@/lib/auth/guard";
import type { Network } from "@/lib/config";
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
 * from the network's archival list (NEAR_ARCHIVAL_RPC_URLS), and this vault's entry of content/proof-evidence.json,
 * which is bundled at build time and checked on every read, so a malformed file shows an error state instead of a
 * result. `network` is the request's: a vault registered on the other one is not served here.
 */
export async function proofDeps(network: Network): Promise<ProofDeps> {
  const settings = getEnv().networks[network];
  const session = await getSession();
  return {
    network,
    publicDb: publicDb(),
    serviceDb: serviceDb(),
    sessionAccount: session?.accountId ?? null,
    makeReader: (vault, store) =>
      makeProofReader({
        network,
        vault,
        store,
        rpc: getRpc(network),
        archivalRpcUrls: settings.archivalRpcUrls,
        evidence: evidenceFor(proofEvidence, network, vault),
      }),
  };
}
