import type { FactoryConfig, VaultRecord, VersionView } from "@probarion/core";
import { assertU64, clampLimit } from "./paging.js";
import type { RpcClient } from "./rpc.js";

/**
 * Read-only views of the Probarion factory. Version ids are 1-based (R14). The values are passed
 * through as the factory sent them, so the verifier's check i, not this client, rejects a 0.
 */
export class FactoryClient {
  readonly factoryId: string;
  private readonly rpc: RpcClient;

  constructor(factoryId: string, rpc: RpcClient) {
    this.factoryId = factoryId;
    this.rpc = rpc;
  }

  versions(): Promise<VersionView[]> {
    return this.rpc.viewFunction<VersionView[]>(this.factoryId, "versions");
  }

  vaultVersion(accountId: string): Promise<number | null> {
    return this.rpc.viewFunction<number | null>(this.factoryId, "vault_version", {
      account_id: accountId,
    });
  }

  getConfig(): Promise<FactoryConfig> {
    return this.rpc.viewFunction<FactoryConfig>(this.factoryId, "get_config");
  }

  async listVaults(fromIndex: number, limit: number): Promise<VaultRecord[]> {
    assertU64("from_index", fromIndex);
    return this.rpc.viewFunction<VaultRecord[]>(this.factoryId, "list_vaults", {
      from_index: fromIndex,
      limit: clampLimit(limit),
    });
  }
}
