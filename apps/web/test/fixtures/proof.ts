// Signed snapshots for the /proof tests, one per headline state, on either network. Every check that core
// runs on them gives a known result, so a test can say exactly which state the page must show.
import { type LedgerEntry, NETWORKS, type Snapshot, type SpendView } from "@probarion/core";
import { InMemoryLedgerStore } from "@probarion/sdk";
import bs58 from "bs58";
import type { Network } from "@/lib/config";
import type { Db } from "@/lib/db/port";
import { appendBody, testSigner } from "./ledger";
import { vaultConfig } from "./reader";

/**
 * An anon Db that serves one public vault, as `public_vault` and `public_ledger` do (paged by `from_seq`), and
 * records every function it is asked for in `calls`.
 */
export function publicDbFor(
  vault: string,
  network: Network,
  ledger: readonly LedgerEntry[],
  calls: string[] = [],
): Db {
  return {
    rpc: async <T>(fn: string, p: Record<string, unknown> = {}) => {
      calls.push(fn);
      if (fn === "public_vault") {
        return (
          p.vault_id === vault
            ? { vault_id: vault, network, kind: "team", display_name: "acme" }
            : null
        ) as T;
      }
      if (fn === "public_ledger") {
        const from = Number(p.from_seq ?? 0);
        return ledger
          .filter((e) => e.body.seq >= from)
          .map((e) => ({
            seq: e.body.seq,
            body_text: JSON.stringify(e.body),
            body_hash: e.body_hash,
            sig: e.sig,
            signer: e.signer,
            link: e.link,
            kind: e.body.kind,
            created_at: "2026-11-08T10:00:00.000Z",
          })) as T;
      }
      throw new Error(`publicDbFor: unexpected ${fn}`);
    },
  };
}

/** A service-role Db that must not be used: every call throws. */
export const noServiceDb: Db = {
  rpc: async (fn: string) => {
    throw new Error(`the service role must not be used here (${fn})`);
  },
};

/** A well-formed NEAR tx hash (base58 of 32 bytes), different for every `n` from 1 to 255. */
export const txHash = (n: number): string => bs58.encode(new Uint8Array(32).fill(n));

/** A trusted code hash: the one the snapshot's canonical factory lists as version 1. */
const CODE_HASH = txHash(200);
const ADDRESS = "0x5290000000000000000000000000000000000001";

export type ProofState = "ok" | "unproven" | "failed";

/**
 * A snapshot of `vault` on `network` whose report is:
 *  - `ok`: every check passes (one decision, its spend paid to a NEAR account, one anchor);
 *  - `unproven`: the spend was burned to Base and no payment entry names its burn tx, so h is unproven;
 *  - `failed`: as `ok`, but the anchor's root is not the ledger's link, so c fails at seq 0.
 */
export async function proofSnapshot(
  state: ProofState,
  o: { vault?: string; network?: Network } = {},
): Promise<Snapshot> {
  const network = o.network ?? "mainnet";
  const n = NETWORKS[network];
  const vault = o.vault ?? `acme.${n.factory}`;
  const signer = testSigner();
  const store = new InMemoryLedgerStore();
  const decision: LedgerEntry = await store.append(appendBody(vault), signer.sign);
  const burned = state === "unproven";
  const spend: SpendView = {
    id: 1,
    mandate_id: 1,
    amount: "25000000",
    invoice_hash: "a".repeat(64),
    ref: "INV-1",
    decision_hash: decision.body_hash,
    agent_pk: "ed25519:agent",
    destination: burned
      ? { type: "intents", chain: "base", address: ADDRESS, asset: n.allowedAssets.base }
      : { type: "near", account_id: `vendor.${network === "mainnet" ? "near" : "testnet"}` },
    status: burned ? "burned" : "paid",
    created_at_ns: "1",
    held_until_ns: null,
    memo: null,
  };
  return {
    v: 1,
    vault,
    network,
    taken_at: "2026-11-08T12:00:00.000Z",
    ledger: [decision],
    chain: {
      access_keys: [
        {
          public_key: signer.publicKey,
          permission: { receiver_id: vault, method_names: ["anchor"], allowance: "1" },
        },
      ],
      code_hash: CODE_HASH,
      config: vaultConfig({
        ledger_key: signer.publicKey,
        usdc: n.usdc,
        intents: n.intents,
        allowed_assets: [n.allowedAssets.base],
        factory: n.factory,
      }),
      anchors: [
        {
          seq: 1,
          root: state === "failed" ? "f".repeat(64) : decision.link,
          count: 1,
          at_ns: "2",
          ledger_key: signer.publicKey,
        },
      ],
      spends: [spend],
      intents_public_keys: [],
      intents_predecessor_auth: true,
      factory_version: 1,
      factory_versions: [
        { index: 1, code_hash: CODE_HASH, mode: "global", notes: "v1", at_ns: "1" },
      ],
      mandates: [],
      burns: [],
    },
    expected_code_hashes: [CODE_HASH],
    pre_ledger_decision_hashes: [],
  };
}
