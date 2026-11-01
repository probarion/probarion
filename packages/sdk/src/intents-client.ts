import { ViewError } from "./errors.js";
import type { RpcClient } from "./rpc.js";

/** Read-only views of the NEAR Intents verifier (`intents.near`, or the intents-stub on testnet). */
export class IntentsClient {
  readonly intentsId: string;
  private readonly rpc: RpcClient;

  constructor(intentsId: string, rpc: RpcClient) {
    this.intentsId = intentsId;
    this.rpc = rpc;
  }

  /** The public keys registered for `accountId`. A vault must have none (I8). */
  async publicKeysOf(accountId: string): Promise<string[]> {
    const keys = await this.rpc.viewFunction<string[] | null>(this.intentsId, "public_keys_of", {
      account_id: accountId,
    });
    if (keys === null) return [];
    if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
      throw new ViewError(this.intentsId, "public_keys_of", "the answer is not a list of keys");
    }
    return keys;
  }

  async isAuthByPredecessorIdEnabled(accountId: string): Promise<boolean> {
    return (
      (await this.rpc.viewFunction<boolean>(this.intentsId, "is_auth_by_predecessor_id_enabled", {
        account_id: accountId,
      })) === true
    );
  }

  /** POA token balance held by `accountId` inside intents (NEP-245 token id `nep141:<asset>`). */
  async poaBalance(accountId: string, asset: string): Promise<bigint> {
    const balance = await this.rpc.viewFunction<string | null>(this.intentsId, "mt_balance_of", {
      account_id: accountId,
      token_id: `nep141:${asset}`,
    });
    if (balance === null) return 0n;
    if (typeof balance !== "string" || !/^\d+$/.test(balance)) {
      throw new ViewError(this.intentsId, "mt_balance_of", "the answer is not a decimal balance");
    }
    return BigInt(balance);
  }
}
