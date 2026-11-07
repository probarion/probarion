// The line after each moment that makes the point: the ledger test catching an edit, an answer on the Canary and a
// proof page. Each gives the visitor somewhere to go next on this site, not only GitHub or an explorer.
import { CONSOLE_ROUTE, PROOF_ROUTE } from "./facts";

export interface NextStepCopy {
  /** Plain text before the link, when there is one. */
  lead?: string;
  /** The link's words. The arrow after them is markup, hidden from screen readers. */
  text: string;
  route: string;
}

export const NEXT_STEP = {
  /**
   * After a run the verifier failed, on the landing page. It promises no live vault: until the demo vault's proof page
   * is public, /proof explains what a proof page shows and opens one by name; after, it goes straight to the demo vault.
   */
  tamper: {
    lead: "Caught.",
    text: "A vault's public proof page runs these same checks",
    route: PROOF_ROUTE,
  },
  /** Under every answer on the Canary, whatever stopped it. The console asks for a sign-in first. */
  canary: { text: "Put limits like these on your own agent", route: CONSOLE_ROUTE },
  /** At the foot of a proof page whose checks ran, public or for members only. */
  proof: { text: "Put your agent behind a mandate", route: CONSOLE_ROUTE },
} as const satisfies Record<string, NextStepCopy>;
