import type { AnchorView, LedgerEntry, Snapshot, SpendView } from "@probarion/core";
import { vaultConfig } from "./reader";

export function makeSnapshot(p: {
  vault: string;
  ledger: LedgerEntry[];
  ledgerKey: string;
  anchors?: AnchorView[];
  spends?: SpendView[];
  burns?: Snapshot["chain"]["burns"];
}): Snapshot {
  return {
    v: 1,
    vault: p.vault,
    network: "mainnet",
    taken_at: "2026-11-08T12:00:00.000Z",
    ledger: p.ledger,
    chain: {
      access_keys: [
        {
          public_key: p.ledgerKey,
          permission: {
            receiver_id: p.vault,
            method_names: ["anchor"],
            allowance: "250000000000000000000000",
          },
        },
      ],
      code_hash: "codehash1",
      config: vaultConfig({ ledger_key: p.ledgerKey }),
      anchors: p.anchors ?? [],
      spends: p.spends ?? [],
      intents_public_keys: [],
      intents_predecessor_auth: true,
      factory_version: 1,
      factory_versions: [
        { index: 1, code_hash: "codehash1", mode: "global", notes: "v1", at_ns: "1" },
      ],
      burns: p.burns ?? [],
    },
    expected_code_hashes: ["codehash1"],
    pre_ledger_decision_hashes: [],
  } as Snapshot;
}
