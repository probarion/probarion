import { NETWORKS } from "@probarion/core";

export type Network = "mainnet" | "testnet";

export const AUTH_RECIPIENT = "probarion.xyz";
export const SECURITY_EMAIL = "security@probarion.xyz";
export const SUPPORT_EMAIL = "support@probarion.xyz";
export const ALERT_FROM = "Probarion Alerts <alerts@probarion.xyz>";
export const STATUS_PAGE_URL = "https://status.probarion.xyz";

/** Spec §12 defaults; the UI pre-fills these. */
export const VAULT_DEFAULTS = {
  dailyBackstopUsdc: "500",
  approvalAboveUsdc: "100",
  heldTtlHours: 72,
  agentAllowanceYocto: "1000000000000000000000000", // 1 NEAR (report §8 key table)
  ledgerAllowanceYocto: "250000000000000000000000", // 0.25 NEAR
} as const;

export function explorerTxUrl(network: Network, hash: string): string {
  return `${NETWORKS[network].explorerTx}${hash}`;
}

export function explorerAccountUrl(network: Network, account: string): string {
  return `${NETWORKS[network].explorerTx.replace("/txns/", "/address/")}${account}`;
}

export function appOrigin(src: Record<string, string | undefined> = process.env): string {
  const prod = src.VERCEL_PROJECT_PRODUCTION_URL;
  return prod ? `https://${prod}` : "http://localhost:3000";
}
