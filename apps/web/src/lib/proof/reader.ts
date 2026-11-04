import { type LedgerStore, Probarion, type ProbarionDeps, RpcClient } from "@probarion/sdk";
import type { Network } from "@/lib/config";
import { log } from "@/lib/log";
import type { VaultEvidence } from "./evidence";
import type { SnapshotSource } from "./service";

export interface ProofReaderInput {
  network: Network;
  vault: string;
  /** Where the ledger comes from: the public reader for a public vault, the tenant's own for a member. */
  store: LedgerStore;
  /** The NEAR RPC client the console uses (`getRpc()`). */
  rpc: RpcClient;
  /** `NEAR_ARCHIVAL_RPC_URLS`; empty means unset, and then no archival lookup is made. */
  archivalRpcUrls: readonly string[];
  /** This vault's entry of content/proof-evidence.json. */
  evidence: VaultEvidence;
}

/**
 * Every dependency of `snapshot()`, passed explicitly (R5). Left out, the SDK would read `docs/evidence` (for mainnet
 * v0) and `docs/mainnet-proof.json` from the working directory, and the archival URLs from the environment; none of
 * that exists on Vercel at runtime. `evidenceDir` is not passed: the explicit `preLedgerDecisionHashes` replace it, and
 * the SDK reads that directory only when they are absent. /proof is offline, so there is no O1/O2 verifier and no tx
 * index. `env: {}` keeps the SDK from reading anything else from the process environment.
 */
export function proofReaderDeps(
  o: Pick<ProofReaderInput, "rpc" | "archivalRpcUrls" | "evidence">,
): ProbarionDeps {
  return {
    rpc: o.rpc,
    archivalRpc:
      o.archivalRpcUrls.length > 0
        ? new RpcClient({ urls: [...o.archivalRpcUrls], maxRounds: 2, timeoutMs: 8_000 })
        : null,
    preLedgerDecisionHashes: o.evidence.preLedgerDecisionHashes,
    burnTxHints: o.evidence.burnTxHints,
    onlineVerifier: null,
    txIndex: null,
    env: {},
    logger: { warn: (message, meta) => log.warn("proof.sdk_warning", { message, ...meta }) },
  };
}

/** A read-only Probarion (no agent or ledger key, no model: interfaces v2 §9 read-only mode) for one vault. */
export function makeProofReader(o: ProofReaderInput): SnapshotSource {
  return new Probarion(
    { network: o.network, vault: o.vault, model: null, ledger: o.store },
    proofReaderDeps(o),
  );
}
