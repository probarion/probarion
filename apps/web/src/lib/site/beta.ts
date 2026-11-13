import type { Network } from "@/lib/config";

/**
 * The beta strip's sentences. The strip is a client component (it learns the network from the address in the browser, so
 * the pages stay static), and this module has no runtime import so that it can be loaded there. Until the network is
 * known, the server render and the first paint say only what is true on both networks. On testnet the tokens have no
 * value, so only mainnet asks for small amounts (audit P1-10); testnet also points to the one mainnet vault, whose real
 * USDC the landing's #mainnet section shows. `gaps` links the landing's known gaps, by the id the status list gives them
 * (test/site-facts.test.ts ties the two).
 */
export function betaStrip(network: Network | null) {
  const first =
    network === null
      ? "Unaudited beta."
      : network === "mainnet"
        ? "Unaudited beta on NEAR mainnet. Use small amounts."
        : "Unaudited beta. This site runs on NEAR testnet, with test tokens.";
  return {
    /** The start of `first` the strip sets in bold. */
    bold: network === null ? first : "Unaudited beta",
    first,
    /** On testnet only: the mainnet vault, a link after `first`. Its label is a sentence; the strip adds the period. */
    mainnet:
      network === "testnet"
        ? { label: "One small mainnet vault holds real USDC", href: "/#mainnet" }
        : null,
    custody: "Non-custodial: Probarion holds no owner key.",
    gaps: { label: "Known gaps", href: "/#known-gaps" },
  };
}
