// N3 (account lock audit): the online reader. Two `query` views over any NearRpc, pinned to one block, then the pure
// report from code-identity.ts. Reads public state and signs nothing.
import type { KeyPolicy } from "./access-keys.js";
import { type AccountLockReport, accountLockReport, type RecordedBuild } from "./code-identity.js";
import { isAccountId, isBase58Hash, isRecord } from "./encoding.js";
import { NearFormatError } from "./errors.js";
import type { NearRpc } from "./rpc.js";

/**
 * Reads `view_account` at finality final, then `view_access_key_list` at that answer's `block_hash`, so both views
 * describe one block, and returns `accountLockReport` over them. Throws TypeError for an invalid account id, policy
 * or builds list (before anything is read), NearRpcError when a read fails (a missing account included), and
 * NearFormatError when `view_account` has no block hash or the key list answers for another block.
 */
export async function readAccountLock(
  rpc: NearRpc,
  accountId: string,
  opts: {
    policy?: KeyPolicy;
    builds?: readonly RecordedBuild[] | { entries: readonly RecordedBuild[] };
  } = {},
): Promise<AccountLockReport> {
  if (!isAccountId(accountId)) {
    throw new TypeError("readAccountLock: accountId is not a NEAR account id");
  }
  // The policy and builds are checked against empty views, so a bad option costs no read.
  accountLockReport(accountId, null, { keys: [] }, opts);

  const account = await rpc.call<unknown>("query", {
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
  const blockHash = isRecord(account) ? account.block_hash : undefined;
  if (!isBase58Hash(blockHash)) {
    throw new NearFormatError(
      "view_account.block_hash",
      `view_account ${accountId}: the answer has no 32-byte base58 block_hash to pin the key list to`,
    );
  }
  const list = await rpc.call<unknown>("query", {
    request_type: "view_access_key_list",
    block_id: blockHash,
    account_id: accountId,
  });
  const listHash = isRecord(list) ? list.block_hash : undefined;
  if (listHash !== blockHash) {
    throw new NearFormatError(
      "view_access_key_list.block_hash",
      `view_access_key_list ${accountId}: the answer is for block ${String(JSON.stringify(listHash ?? null)).slice(0, 80)}, not ${blockHash}`,
    );
  }
  return accountLockReport(accountId, account, list, opts);
}
