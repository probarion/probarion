import { CHECK_NAMES, type CheckId } from "@probarion/core";

/**
 * What each verifier check proves and does not prove, keyed in CHECK_NAMES order (packages/core/src/verify.ts). The
 * text comes from the trust/verifier-checks brief and is checked against verify.ts.
 */
export const VERIFIER_DOCS: Readonly<Record<CheckId, { proves: string; limits: string }>> = {
  a: {
    proves:
      "Every entry's `body_hash` recomputes from its body, and its `sig` is a valid ed25519 signature by the ledger key the chain names for its range: that anchor's `ledger_key`, or `config.ledger_key` after the last anchor. The current ledger key is an anchor-only function-call key on the vault.",
    limits: "That the entries link into one chain (check b), or that any decision was right.",
  },
  b: {
    proves:
      "Every `body_hash` and link recomputes, every entry names this vault, seq counts up from 0, and each `prev_link` chains back to the zero link.",
    limits:
      "Who signed the entries (check a), or that the chain is the one the vault anchored (check c).",
  },
  c: {
    proves:
      "Each anchor's root is the link of the entry it names, the anchor seqs run 1, 2, 3 and so on, and the counts never go back.",
    limits:
      "The entries after the last anchored count, which the pass detail counts, or which entry inside a failed range is wrong (checks a and b name it).",
  },
  d: {
    proves:
      "Each on-chain spend's `decision_hash` is the `body_hash` of one decision entry with the spend's invoice, mandate and amount, and the verdict `allow` (or `hold`, only for a spend that was held). No decision covers two spends.",
    limits:
      "That the decision was a good one (the verifier does not run the policy again), or that the invoice is real. A spend from before the ledger existed is exempt when the snapshot lists its hash in `pre_ledger_decision_hashes`, and each listed hash exempts one spend at most.",
  },
  e: {
    proves:
      "Each attested decision passes A1 to A7 offline: the signature, the response, the recorded proposal and the attestation report agree with each other and with the ledger position. A rules-only decision is reported, not failed.",
    limits:
      "That the quote came from genuine TEE hardware (O1, run with `--online`), that the request was the honest one for this invoice (A8, which runs only when the invoice texts are given), or that the invoice is authentic.",
  },
  f: {
    proves:
      "The vault has no full-access key, every other key is the current ledger key or an agent key on the vault, and its code hash is a recorded vault build (`KNOWN_VAULT_CODE_HASHES`) or a version of its network's canonical factory. A snapshot's own `expected_code_hashes` cannot add a hash to that set.",
    limits:
      "That the code is free of bugs (no third party has audited it), or that the factory account itself has no full-access key.",
  },
  g: {
    proves:
      "The vault names its network's NEAR Intents contract, has no public key registered there, and has predecessor auth on.",
    limits: "How the Intents Verifier DAO uses its roles.",
  },
  h: {
    proves:
      "Each burned spend has exactly one matched burn pair: the POA `ft_burn` memo is `WITHDRAW_TO:` plus the mandate's address, and the intents `mt_burn` has the vault as owner and the spend's amount. One transaction burns for one spend.",
    limits:
      "That the bridge released the funds on Base or Solana. A burn whose transaction was not read is unproven, not a pass: `approver_tx`, `not_recorded`, `pre_ledger_no_tx` or `tx_unavailable`.",
  },
  i: {
    proves:
      "A factory vault names its network's canonical Probarion factory and has a version record that factory lists. A vault with no factory is skipped.",
    limits:
      "Anything about a vault deployed without the factory. A vault records the account that called its `new` as its factory, so only the canonical factory counts.",
  },
};

export function checkAnchor(id: CheckId): string {
  return `check-${id}`;
}

/** All checks, or the comma-separated letters in `only`. An unknown letter throws, so a typo fails the build. */
export function selectChecks(only?: string): CheckId[] {
  const all = Object.keys(CHECK_NAMES) as CheckId[];
  if (only === undefined || only.trim() === "") return all;
  return only.split(",").map((raw) => {
    const id = raw.trim();
    if (!(all as string[]).includes(id)) throw new Error(`VerifierChecks: unknown check "${id}"`);
    return id as CheckId;
  });
}
