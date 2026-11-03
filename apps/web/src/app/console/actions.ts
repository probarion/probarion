"use server";

import { FactoryClient } from "@probarion/sdk";
import { revalidatePath } from "next/cache";
import { isDenied, sessionForAction } from "@/lib/console/action-auth";
import { asForm, type CreateVaultForm } from "@/lib/console/create-rules";
import {
  loadFactoryForCreate,
  prepareCreateVault,
  REGISTER_ERROR_TEXT,
  type RegisterError,
  registerVault,
  rpcChainReads,
} from "@/lib/console/vaults";
import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { getReader, getRpc } from "@/lib/near/server";
import type { WalletTx } from "@/lib/near/tx";

// The two actions that come before a vault exists, so they check the session (sessionForAction), not a
// membership. Their arguments come from the browser and are treated as untrusted text.

/**
 * Re-reads the factory (R14: min_deposit and the current version's mode) and builds the
 * create_vault transaction the owner signs. The browser's own figures are never trusted.
 */
export async function prepareCreateVaultAction(
  raw: CreateVaultForm,
): Promise<WalletTx | { error: string; status?: 401 | 403 }> {
  const auth = await sessionForAction();
  if (isDenied(auth)) return auth;
  const env = getEnv();
  const factory = await loadFactoryForCreate(new FactoryClient(env.PROBARION_FACTORY_ID, getRpc()));
  if (!factory.ok) {
    return {
      error:
        "The factory cannot be read right now, so nothing was prepared and nothing was signed. Try again, or use the CLI.",
    };
  }
  const r = prepareCreateVault(asForm(raw), {
    factory: env.PROBARION_FACTORY_ID,
    minDeposit: factory.minDeposit,
    mode: factory.mode,
    owner: auth.accountId,
  });
  if (!r.ok) return { error: Object.values(r.errors).join(" · ") };
  // A warning does not block the create; it rides in the line the owner reads beside the signature.
  return r.warnings.length === 0
    ? r.tx
    : { ...r.tx, summary: `${r.tx.summary}. ${r.warnings.join(" ")}` };
}

export type RegisterActionResult =
  | { ok: true; vaultId: string }
  | { ok: false; error: string; code?: RegisterError; status?: 401 | 403 };

export async function registerVaultAction(vaultId: unknown): Promise<RegisterActionResult> {
  const auth = await sessionForAction();
  if (isDenied(auth)) return { ok: false, ...auth };
  const env = getEnv();
  const id = typeof vaultId === "string" ? vaultId.trim().slice(0, 64) : "";
  const r = await registerVault(
    {
      db: serviceDb(),
      reader: getReader(),
      chain: rpcChainReads(getRpc()),
      network: env.NEAR_NETWORK,
      factoryId: env.PROBARION_FACTORY_ID,
      canaryVaultId: env.CANARY_VAULT_ID,
      teamVaultIds: env.TEAM_VAULT_IDS,
    },
    { vaultId: id, account: auth.accountId },
  );
  if (!r.ok) return { ok: false, error: REGISTER_ERROR_TEXT[r.error], code: r.error };
  revalidatePath("/console");
  return { ok: true, vaultId: id };
}
