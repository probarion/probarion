import type { AnchorView, LedgerEntry, Snapshot, SpendView, VaultConfig } from "@probarion/core";

/**
 * A vault config for a snapshot. Task 8 owns `fixtures/reader.ts` (the full `vaultConfig` and `fakeReader`); this
 * file keeps its own copy so the ledger tests do not wait for it.
 */
function snapshotVaultConfig(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return {
    owner: "acme.near",
    approvers: ["cfo.near"],
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    intents: "intents.near",
    allowed_assets: ["base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"],
    daily_backstop: "500000000",
    held_ttl_ns: "259200000000000",
    frozen: false,
    factory: "vaults.probarion.near",
    version: "0.1.0",
    ledger_key: null,
    ...overrides,
  };
}

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
      config: snapshotVaultConfig({ ledger_key: p.ledgerKey }),
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
