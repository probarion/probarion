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
import { tenantNetwork } from "@/lib/db/tenants";
import { getEnv } from "@/lib/env";
import { ensureChain } from "@/lib/near/chain";
import { getReader, getRpc } from "@/lib/near/server";
import type { WalletTx } from "@/lib/near/tx";
import { isNearAccountId } from "@/lib/near/validate";
import { requestNetwork, wrongNetworkSentence } from "@/lib/network";

// The two actions that come before a vault exists, so they check the session (sessionForAction), not a
// membership. Their arguments come from the browser and are treated as untrusted text.

/**
 * Re-reads the factory (R14: min_deposit and the current version's mode) and builds the
 * create_vault transaction the owner signs. The browser's own figures are never trusted.
 */
export async function prepareCreateVaultAction(
  raw: CreateVaultForm,
): Promise<WalletTx | { error: string; status?: 401 | 403 | 409 }> {
  const auth = await sessionForAction();
  if (isDenied(auth)) return auth;
  // Create and Register use the network of the address the owner is signed in at (W-NET-R4).
  const network = await requestNetwork();
  const factoryId = getEnv().networks[network].factoryId;
  const factory = await loadFactoryForCreate(new FactoryClient(factoryId, getRpc(network)));
  if (!factory.ok) {
    return {
      error:
        "The factory cannot be read right now, so nothing was prepared and nothing was signed. Try again, or use the CLI.",
    };
  }
  const r = prepareCreateVault(asForm(raw), {
    factory: factoryId,
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
  | { ok: false; error: string; code?: RegisterError; status?: 401 | 403 | 409 | 503 };

export async function registerVaultAction(vaultId: unknown): Promise<RegisterActionResult> {
  const auth = await sessionForAction();
  if (isDenied(auth)) return { ok: false, ...auth };
  const network = await requestNetwork();
  const settings = getEnv().networks[network];
  const id = typeof vaultId === "string" ? vaultId.trim().slice(0, 64) : "";
  // A tenant's network is fixed (W-NET-R4). A vault that is registered on the other network is not registered here: the
  // answer is the 409 every vault action gives, found before any chain client is made and before anything is written.
  // (tenant_register refuses it as well, for a registration that races this one.)
  if (isNearAccountId(id)) {
    const registeredOn = await tenantNetwork(serviceDb(), id);
    if (registeredOn !== null && registeredOn !== network) {
      return {
        ok: false,
        error: wrongNetworkSentence(registeredOn),
        code: "network_mismatch",
        status: 409,
      };
    }
  }
  const rpc = getRpc(network);
  const r = await registerVault(
    {
      db: serviceDb(),
      reader: getReader(network),
      chain: rpcChainReads(rpc),
      network,
      factoryId: settings.factoryId,
      canaryVaultId: settings.canaryVaultId,
      teamVaultIds: settings.teamVaultIds,
      verifyChain: () => ensureChain(network, rpc),
    },
    { vaultId: id, account: auth.accountId },
  );
  if (!r.ok) {
    // network_mismatch gets here only from a registration that raced another one (the database's refusal names no
    // network); wrong_chain is the setting gone wrong, a 503 as on sign-in.
    const status =
      r.error === "network_mismatch" ? 409 : r.error === "wrong_chain" ? 503 : undefined;
    return {
      ok: false,
      error: REGISTER_ERROR_TEXT[r.error],
      code: r.error,
      ...(status === undefined ? {} : { status }),
    };
  }
  revalidatePath("/console");
  return { ok: true, vaultId: id };
}
