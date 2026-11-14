import { ProofSkeleton } from "@/components/proof/ProofSkeleton";

/**
 * Shown at once when /proof or a vault's proof page is opened, while the ledger is read and the checks run: the
 * header pill's trip (/proof, then the demo vault's page) shows the proof page's head instead of an empty page.
 * The rate limit is taken in the page (readProof), below this boundary, so a prefetch of the shell takes no token.
 */
export default function ProofLoading() {
  return <ProofSkeleton />;
}
