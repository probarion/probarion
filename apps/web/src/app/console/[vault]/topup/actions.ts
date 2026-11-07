"use server";

import { isDenied, memberForAction } from "@/lib/console/action-auth";
import { isVaultConfig } from "@/lib/console/vaults";
import { log } from "@/lib/log";
import { chainConsts, getReader } from "@/lib/near/server";
import { fundVaultUsdcTx, type WalletTx } from "@/lib/near/tx";
import { parseFundAmount } from "@/lib/topup/amount";

/**
 * Owner only. Returns the transaction the owner signs in their own wallet: `storage_deposit` then
 * `ft_transfer` of this network's USDC to the vault. Nothing is prepared unless the chain agrees with the
 * console: the signed-in account is the vault's owner and the vault holds this network's USDC (USDC sent to
 * a vault that holds another token would not be the token it counts). The vault id comes from the membership
 * row, never from the browser's word alone.
 */
export async function prepareFundAction(
  vault: string,
  amountUsdc: string,
): Promise<WalletTx | { error: string; status?: 401 | 403 | 409 }> {
  const auth = await memberForAction(vault, ["owner"]);
  if (isDenied(auth)) return auth;
  const amount = typeof amountUsdc === "string" ? parseFundAmount(amountUsdc) : null;
  if (amount === null) return { error: "Invalid amount" };
  if ("problem" in amount) return { error: amount.problem };

  const { member, session } = auth;
  const unread = {
    error: "The vault could not be read from NEAR, so nothing was prepared. Try again.",
  };
  let config: unknown;
  try {
    config = await getReader(member.network).getConfig(member.vault_id);
  } catch (error) {
    log.warn("topup.config_unreadable", { vault: member.vault_id, error });
    return unread;
  }
  if (!isVaultConfig(config)) {
    log.warn("topup.config_unreadable", { vault: member.vault_id, error: "not a vault config" });
    return unread;
  }
  if (config.owner !== session.accountId) {
    return {
      error: `The chain names ${config.owner} as this vault's owner, not ${session.accountId}, so nothing was prepared.`,
    };
  }
  const { usdc } = chainConsts(member.network);
  if (config.usdc !== usdc) {
    return {
      error: `This vault's token is ${config.usdc}, not this network's USDC (${usdc}), so nothing was prepared.`,
    };
  }
  return fundVaultUsdcTx(usdc, member.vault_id, amount.units);
}
