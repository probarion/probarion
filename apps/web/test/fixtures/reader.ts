import { NETWORKS, type VaultConfig } from "@probarion/core";
import type { ViewAccountResult } from "@probarion/sdk";
import type { VaultReader } from "@/lib/near/reader";

/** A vault's `get_config` answer. Ids come from NETWORKS, so no long literal ends up in a test. */
export function vaultConfig(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return {
    owner: "acme.near",
    approvers: ["cfo.near"],
    usdc: NETWORKS.mainnet.usdc,
    intents: NETWORKS.mainnet.intents,
    allowed_assets: [NETWORKS.mainnet.allowedAssets.base],
    daily_backstop: "500000000",
    held_ttl_ns: "259200000000000",
    frozen: false,
    factory: NETWORKS.mainnet.factory,
    version: "0.1.0",
    ledger_key: null,
    ...overrides,
  };
}

/**
 * A VaultReader whose views answer from `overrides`. Views a test did not stub throw, except the
 * list views (empty) and the two balances ("0"); a test about balances stubs them explicitly.
 */
export function fakeReader(overrides: Partial<VaultReader> = {}): VaultReader {
  const missing = (name: string) => async () => {
    throw new Error(`fakeReader.${name} not stubbed`);
  };
  return {
    getConfig: missing("getConfig"),
    listMandates: async () => [],
    listSpends: async () => [],
    listAnchors: async () => [],
    listAgents: async () => [],
    ftBalance: async () => "0",
    intentsBalance: async () => "0",
    accessKey: missing("accessKey"),
    factoryConfig: missing("factoryConfig"),
    accountExists: async () => false,
    ...overrides,
  };
}

/**
 * A `view_account` answer as the SDK returns it: 3 NEAR, 2,232 bytes of storage, own code. Pass
 * `code_hash` / `global_contract_hash` for a code-identity test.
 */
export function viewAccount(overrides: Partial<ViewAccountResult> = {}): ViewAccountResult {
  return {
    amount: "3000000000000000000000000",
    locked: "0",
    code_hash: "11111111111111111111111111111111",
    global_contract_hash: null,
    storage_usage: 2_232,
    ...overrides,
  };
}
