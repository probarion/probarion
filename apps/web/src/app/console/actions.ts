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
import { memberRole } from "@/lib/db/tenants";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { ensureChain } from "@/lib/near/chain";
import { getReader, getRpc } from "@/lib/near/server";
import type { WalletTx } from "@/lib/near/tx";
import { isNearAccountId } from "@/lib/near/validate";
import { requestNetwork, wrongNetworkSentence } from "@/lib/network";
import { LIMITS, takeToken } from "@/lib/ratelimit";

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
  | { ok: false; error: string; code?: RegisterError; status?: 401 | 403 | 409 | 429 | 503 };

const REGISTER_LIMITED =
  "Too many attempts to register a vault just now. Try again in a few minutes.";

export async function registerVaultAction(vaultId: unknown): Promise<RegisterActionResult> {
  const auth = await sessionForAction();
  if (isDenied(auth)) return { ok: false, ...auth };
  const network = await requestNetwork();
  const settings = getEnv().networks[network];
  // One attempt costs a chain read and a membership read: a bucket for each account on each network.
  try {
    const [max, windowSeconds] = LIMITS.registerPerAccount;
    const bucket = `register:${network}:${auth.accountId}`;
    if (!(await takeToken(serviceDb(), bucket, max, windowSeconds)).allowed) {
      return { ok: false, error: REGISTER_LIMITED, status: 429 };
    }
  } catch (error) {
    // A call that cannot be counted does not run.
    log.error("register.limiter_failed", { error });
    return { ok: false, error: REGISTER_ERROR_TEXT.unavailable, code: "unavailable", status: 503 };
  }
  const id = typeof vaultId === "string" ? vaultId.trim().slice(0, 64) : "";
  // A tenant's network is fixed (W-NET-R4). A member of a vault that is registered on the other network is told so, with the
  // 409 every vault action gives, before any chain client is made and before anything is written; the membership is read
  // the way the guards read it, so no one else is told which network a vault is on (W-NET-R5). Anyone else goes on as for
  // a vault nobody registered, on this network's chain. tenant_register refuses a takeover as well (owner_mismatch for
  // another owner, network_mismatch for the same owner, whom the line above has already answered, or a race).
  if (isNearAccountId(id)) {
    const member = await memberRole(serviceDb(), id, auth.accountId);
    if (member !== null && member.vault_id === id && member.network !== network) {
      return {
        ok: false,
        error: wrongNetworkSentence(member.network),
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
      verifyChain: () => ensureChain(network, settings.rpcUrls),
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
