"use server";

import { isDenied, memberForAction } from "@/lib/console/action-auth";
import {
  asMandateForm,
  buildMandateInput,
  describeErrors,
  type MandateForm,
} from "@/lib/console/mandates";
import { isVaultConfig } from "@/lib/console/vaults";
import { log } from "@/lib/log";
import { chainErrorKind } from "@/lib/near/reader";
import { chainConsts, getReader } from "@/lib/near/server";
import { createMandateTx, type WalletTx } from "@/lib/near/tx";

export type PrepareMandateResult = WalletTx | { error: string; status?: 401 | 403 };

/**
 * Builds the `create_mandate` transaction the owner signs in their own wallet. The browser's form is
 * untrusted text: the vault only names the vault whose OWNER the caller must be (the membership row
 * decides, `memberForAction` with the owner role; the tenant and the role never come from the form),
 * and the form is re-checked here by the same `buildMandateInput` the browser ran, against the chain's
 * own `allowed_assets` and agent keys read now, so a forged or stale form cannot get a mandate signed
 * that the vault would refuse, or one for a key that was removed since the page loaded.
 */
export async function prepareMandateAction(
  vault: string,
  form: MandateForm,
): Promise<PrepareMandateResult> {
  const auth = await memberForAction(typeof vault === "string" ? vault : "", ["owner"]);
  if (isDenied(auth)) return auth;
  const id = auth.member.vault_id;

  let config: unknown;
  let agents: unknown;
  try {
    const reader = getReader();
    [config, agents] = await Promise.all([reader.getConfig(id), reader.listAgents(id)]);
  } catch (e) {
    log.warn("console.mandate_prepare_read_failed", {
      vault: id,
      kind: chainErrorKind(e) ?? "error",
    });
    return {
      error:
        "The vault cannot be read right now, so nothing was prepared and nothing was signed. Try again in a moment.",
    };
  }
  if (
    !isVaultConfig(config) ||
    !Array.isArray(agents) ||
    !agents.every((a) => typeof a === "object" && a !== null && typeof a.public_key === "string")
  ) {
    return {
      error:
        "The vault's answer could not be read, so nothing was prepared and nothing was signed.",
    };
  }
  // The membership row says owner; the chain says who the contract will accept.
  if (config.owner !== auth.session.accountId) {
    return { error: "Only the vault's owner can create mandates.", status: 403 };
  }
  const consts = chainConsts();
  if (config.usdc !== consts.usdc) {
    return {
      error: `This vault's token is ${config.usdc}, not this network's USDC. The console cannot know its decimals, so it does not create mandates for it.`,
    };
  }

  const r = buildMandateInput(asMandateForm(form), {
    now: new Date(),
    vault: id,
    baseAsset: consts.allowedAssets.base,
    allowedAssets: config.allowed_assets,
    agentKeys: (agents as { public_key: string }[]).map((a) => a.public_key),
  });
  if (!r.ok) return { error: describeErrors(r.errors) };
  try {
    return createMandateTx(id, r.input);
  } catch (e) {
    // buildMandateInput keeps every value inside the builder's bounds; if one slips through it is still an answer, not a throw.
    return { error: `The transaction could not be built: ${(e as Error).message}` };
  }
}
