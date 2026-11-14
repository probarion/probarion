import { ProofSkeleton } from "@/components/proof/ProofSkeleton";

/**
 * Shown at once when /proof or a vault's proof page is opened, while the ledger is read and the checks run: the
 * header pill's trip (/proof, then the demo vault's page) shows the proof page's head instead of an empty page.
 * The rate limit is taken in the page (readProof), below this boundary, so a prefetch of the shell takes no token.
 *
 * The shell starts the response before the page runs, and that fixes its HTTP status at 200 (Next's loading.md,
 * "Status codes"): opened directly, an unknown or private vault gets the not-found page marked noindex (a soft 404),
 * and /proof's redirect to the demo vault is carried by the stream, not a 307. Accepted for the shell; the runbook
 * says so (docs/runbooks/web-deploy.md).
 */
export default function ProofLoading() {
  return <ProofSkeleton />;
}
