import type { MandateView } from "@probarion/core";
import { purposeMatch } from "@probarion/core";

/**
 * Whether the contract could still accept a spend on `m` from its own agent at `now`: not revoked, not
 * expired, a use left and room under its total (core's `spendable`, policy.ts, which core does not export).
 *
 * It is asked through `purposeMatch` itself, so the answer can never drift from the SDK's own selection: with
 * a decoy ranked first that no key can spend (revoked, lowest id), purposeMatch returns `m` exactly when `m` is
 * spendable by `m.agent_pk`, and the decoy otherwise.
 */
export function spendableNow(m: MandateView, now: Date): boolean {
  const decoy: MandateView = { ...m, id: Number.MIN_SAFE_INTEGER, status: "revoked" };
  return purposeMatch([decoy, m], m.purpose_hash, now, m.agent_pk) === m;
}

/**
 * The mandate a Payables cycle runs for, and so the agent key it signs with (`mandate.agent_pk`:
 * never another key). Null when no mandate has the invoice's purpose (or the invoice has none): there is then
 * no key to sign with, and nothing is run.
 *
 * In order:
 * 1. the lowest-id spendable mandate bound to an agent key that is active here. Given that key, the SDK's
 *    `purposeMatch` picks this same mandate (it is the lowest-id spendable one bound to that key);
 * 2. else the lowest-id spendable mandate: its key is not active here, so the caller skips the cycle and says
 *    which mandate needs which key;
 * 3. else (nothing spendable) the lowest-id mandate bound to an active key, so the SDK runs and refuses with
 *    the precise reason (expired, revoked, uses or total exhausted), recorded in the ledger;
 * 4. else the lowest-id mandate, whose key is not active: skipped as in 2.
 */
export function signingMandate(
  mandates: readonly MandateView[],
  purposeHash: string | null,
  now: Date,
  activeAgentKeys: ReadonlySet<string>,
): MandateView | null {
  if (purposeHash === null) return null;
  const matches = mandates
    .filter((m) => m.purpose_hash === purposeHash)
    .sort((a, b) => a.id - b.id);
  const signable = (m: MandateView) => activeAgentKeys.has(m.agent_pk);
  return (
    matches.find((m) => signable(m) && spendableNow(m, now)) ??
    matches.find((m) => spendableNow(m, now)) ??
    matches.find(signable) ??
    matches[0] ??
    null
  );
}
