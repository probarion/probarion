import type { Network } from "@/lib/config";

// The words of the operations pages (/status, /security, /terms, /privacy), in one module so that ops-copy.test.ts can
// hold them to the repository: no claim that has not shipped, no contact or host that does not exist yet, no reward.
// Backticks render as <code> through components/site/Rich.tsx.

export const STATUS_PAGE = {
  meta: {
    title: "Status",
    description:
      "Live checks of this address: the NEAR RPC providers it reads and NEAR AI Cloud's model list.",
  },
  eyebrow: "Status",
  title: "Status",
  lede: (network: Network) =>
    `This address serves NEAR ${network}. These checks ran when the page loaded and are at most 30 seconds old.`,
  rpcTitle: "NEAR RPC",
  nearaiTitle: "NEAR AI Cloud",
  up: "passing",
  down: "failing",
  settings:
    "The server's settings could not be read, so the NEAR RPC checks did not run. The console is unavailable until they are fixed.",
  noKey: "The model key is not set on this deployment, so decisions use the code rules only.",
  failed: "The checks could not run. Reload the page in a minute.",
  checkedAt: (iso: string) => `Checked at ${iso.slice(0, 19).replace("T", " ")} UTC.`,
  funds:
    "Funds stay in your own vault. If Probarion is down, your vault and its limits keep working on chain, and you can freeze it, withdraw and remove agent keys from your own wallet.",
  other: (network: Network) => `Status of the ${network} address`,
  whatWorks: "What works today, and what does not",
} as const;
