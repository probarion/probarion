import { NETWORKS, type NetworkId } from "@probarion/core";
import type { TenantKind } from "@/lib/db/tenants";
import { productionOrigin } from "@/lib/site/network";

export type Network = NetworkId;

export const AUTH_RECIPIENT = "probarion.xyz";
// No security or support mailbox and no status host: a security report goes the way SECURITY.md says.
export const ALERT_FROM = "Probarion Alerts <alerts@probarion.xyz>";

/** Spec §12 defaults; the UI pre-fills these. */
export const VAULT_DEFAULTS = {
  dailyBackstopUsdc: "500",
  approvalAboveUsdc: "100",
  heldTtlHours: 72,
  agentAllowanceYocto: "1000000000000000000000000", // 1 NEAR (report §8 key table)
  ledgerAllowanceYocto: "250000000000000000000000", // 0.25 NEAR
} as const;

/**
 * The keys of a Canary vault (tenant kind "canary"). Every public attempt anchors the Canary's ledger with the ledger
 * key, and a raw attempt sends a spend with the agent key. The Canary closes when the ledger key's allowance is under
 * CANARY_LIMITS.minLedgerAllowanceYocto (0.5 NEAR), and raw mode stops when the agent key's is under minAllowanceYocto
 * (0.2 NEAR), so the defaults above would leave it closed. A key's allowance is fixed when the vault adds it.
 */
export const CANARY_KEY_ALLOWANCES = {
  agentAllowanceYocto: "3000000000000000000000000", // 3 NEAR
  ledgerAllowanceYocto: "2000000000000000000000000", // 2 NEAR
} as const;

/** The allowances the console asks the owner to sign when they add a key, by the vault's tenant kind. */
export function keyAllowances(kind: TenantKind): {
  agentAllowanceYocto: string;
  ledgerAllowanceYocto: string;
} {
  return kind === "canary" ? CANARY_KEY_ALLOWANCES : VAULT_DEFAULTS;
}

export function explorerTxUrl(network: Network, hash: string): string {
  return `${NETWORKS[network].explorerTx}${encodeURIComponent(hash)}`;
}

export function explorerAccountUrl(network: Network, account: string): string {
  return `${NETWORKS[network].explorerTx.replace("/txns/", "/address/")}${encodeURIComponent(account)}`;
}

/** The address the site is served at: the production address, else localhost. The default network's origin when it sets none. */
export function appOrigin(src: Record<string, string | undefined> = process.env): string {
  return productionOrigin(src);
}
