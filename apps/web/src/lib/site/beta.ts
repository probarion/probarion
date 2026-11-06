import type { Network } from "@/lib/config";

/**
 * The beta strip's sentences. The strip is a client component (it learns the network from the address in the browser, so
 * the pages stay static), and this module has no runtime import so that it can be loaded there. `where` is null until
 * the network is known: the server render and the first paint say only what is true on both networks.
 */
export function betaStrip(network: Network | null) {
  return {
    lead: "Unaudited beta.",
    where:
      network === null
        ? null
        : network === "mainnet"
          ? "Runs on NEAR mainnet."
          : "Runs on NEAR testnet with test tokens.",
    audit: "No third party has audited this code.",
    custody: "Non-custodial: Probarion holds no owner key.",
    amounts: "Use small amounts.",
  };
}
