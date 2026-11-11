import { publicKeyFromSecret } from "@probarion/core";
import {
  FileLedgerStore,
  type LedgerStore,
  Probarion,
  type ProbarionDeps,
  RpcClient,
  VaultClient,
} from "@probarion/sdk";
import type { McpConfig } from "./config.js";
import { withSingleWriterGuard } from "./guard.js";
import type { ProbarionPort } from "./port.js";

/** What `buildPort` reads of the config: all of it but where the keys came from and the ledger key's public half. */
export type PortConfig = Omit<McpConfig, "keysSource" | "ledgerPublicKey">;

/**
 * The port over a `Probarion` instance, guarded so that a spend from a second ledger file, or onto a ledger tail
 * that another ledger key signed, is refused. The MCP client decides; this server makes no model call of its own
 * (`model: null`), so its spends are recorded as unattested proposals and decided by Probarion's rules. The SDK
 * reads no environment of its own here: every RPC URL it uses is one `loadConfig` checked.
 */
export function buildPort(
  cfg: PortConfig,
  deps: ProbarionDeps = {},
  ledger: LedgerStore = new FileLedgerStore(cfg.ledgerPath),
): ProbarionPort {
  const env =
    cfg.archivalRpcUrls === null ? {} : { NEAR_ARCHIVAL_RPC_URLS: cfg.archivalRpcUrls.join(",") };
  const pb = new Probarion(
    {
      network: cfg.network,
      vault: cfg.vault,
      agentKey: cfg.agentKey ?? undefined,
      ledgerKey: cfg.ledgerKey ?? undefined,
      rpcUrls: cfg.rpcUrls,
      model: null,
      ledger,
    },
    { env, ...deps },
  );
  const vault = new VaultClient(cfg.vault, deps.rpc ?? new RpcClient({ urls: cfg.rpcUrls }));
  const port: ProbarionPort = {
    listMandates: () => pb.mandates.list(),
    checkSpend: (input) => pb.checkSpend(input),
    requestSpend: (input) => pb.requestSpend({ ...input, evidence: null }),
    getSpend: (spendId) => pb.spends.get(spendId),
    findSpendByRef: async (ref) => (await vault.listAllSpends()).find((s) => s.ref === ref) ?? null,
    verify: () => pb.verify(),
  };
  const ledgerPublicKey = cfg.ledgerKey === null ? null : publicKeyFromSecret(cfg.ledgerKey);
  return withSingleWriterGuard(port, ledger, () => pb.anchors.latest(), ledgerPublicKey);
}
