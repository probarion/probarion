"use server";

import { revalidatePath } from "next/cache";
import { isDenied, memberForAction } from "@/lib/console/action-auth";
import { REGISTER_ERROR_TEXT, registerVault, rpcChainReads } from "@/lib/console/vaults";
import { serviceDb } from "@/lib/db/clients";
import { setTenantSettings } from "@/lib/db/tenants";
import { getEnv } from "@/lib/env";
import { getReader, getRpc } from "@/lib/near/server";

/** What the settings form shows after a submit. */
export type SettingsState =
  | null
  | { ok: true; message: string }
  | { ok: false; error: string; status?: 401 | 403 | 409 };

// `vault` is bound by the page, but a bound argument comes back from the browser, so it is only a
// lookup key: the tenant id and the role come from the membership row (memberForAction), never
// from the form.

export async function updateSettingsAction(
  vault: string,
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const auth = await memberForAction(vault, ["owner"]);
  if (isDenied(auth)) return { ok: false, ...auth };
  // The Canary's ledger is private (the form has no such checkbox, and the database refuses it): its kind comes from the
  // membership row, never from the form, and no public proof is sent for it.
  const saved = await setTenantSettings(serviceDb(), auth.member.tenant_id, {
    zeroRetention: formData.get("zero_retention") === "on",
    ...(auth.member.kind === "canary"
      ? {}
      : { proofPublic: formData.get("proof_public") === "on" }),
  });
  revalidatePath(`/console/${auth.member.vault_id}`);
  return {
    ok: true,
    message: `Saved. Zero-retention ${saved.zero_retention ? "on" : "off"}; public proof page ${saved.proof_public ? "on" : "off"}.`,
  };
}

/** Re-reads get_config so the approvers on chain are reflected in membership (R11 re-registration). */
export async function refreshMembersAction(
  vault: string,
  _prev: SettingsState,
  _formData?: FormData,
): Promise<SettingsState> {
  const auth = await memberForAction(vault, ["owner"]);
  if (isDenied(auth)) return { ok: false, ...auth };
  // The vault's own network, which the guard has shown to be the request's.
  const network = auth.member.network;
  const settings = getEnv().networks[network];
  const r = await registerVault(
    {
      db: serviceDb(),
      reader: getReader(network),
      chain: rpcChainReads(getRpc(network)),
      network,
      factoryId: settings.factoryId,
      canaryVaultId: settings.canaryVaultId,
      teamVaultIds: settings.teamVaultIds,
    },
    // No display name: the stored one is kept (migration 0005).
    { vaultId: auth.member.vault_id, account: auth.session.accountId },
  );
  if (!r.ok) return { ok: false, error: REGISTER_ERROR_TEXT[r.error] };
  revalidatePath(`/console/${auth.member.vault_id}`);
  return { ok: true, message: "Approvers re-read from the chain." };
}
