"use server";

import { revalidatePath } from "next/cache";
import { VAULT_DEFAULTS } from "@/lib/config";
import { isDenied, memberForAction } from "@/lib/console/action-auth";
import { rpcChainReads } from "@/lib/console/vaults";
import { masterKey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import {
  cleanLabel,
  describeCheck,
  isKeyPurpose,
  type KeepState,
  type KeyPurpose,
  type KeySyncState,
  keepResultText,
  type VaultCode,
} from "@/lib/keys/rules";
import { discardKey, keepKey, reuseOrGenerateKey, syncKeyStatuses } from "@/lib/keys/service";
import { readVaultCode } from "@/lib/keys/view";
import { log } from "@/lib/log";
import { getReader, getRpc } from "@/lib/near/server";
import { addAgentTx, setLedgerKeyTx, type WalletTx } from "@/lib/near/tx";

// `vault`, `purpose` and `label` come back from the browser (bound or typed), so `vault` is only a
// lookup key: the tenant and the role come from the membership row (memberForAction → memberForApi),
// and the transaction is built for the member's own vault id. Nothing here ever returns, logs or
// throws a secret: generateKey seals it before it is stored and hands back the public key only.

/**
 * Owner only. Returns the transaction the owner signs in their own wallet: `add_agent` for an agent
 * key, `set_ledger_key` for the ledger key, with the PUBLIC key. The key is a recent unused pending
 * key of the same purpose when there is one (under 24 h, never seen on chain), else a new key generated
 * on the server (W-T10-R1).
 */
export async function generateKeyAction(
  vault: string,
  purpose: KeyPurpose,
  label: string,
): Promise<WalletTx | { error: string; status?: 401 | 403 }> {
  const auth = await memberForAction(vault, ["owner"]);
  if (isDenied(auth)) return auth;
  if (!isKeyPurpose(purpose)) return { error: "Unknown key purpose." };
  const clean = cleanLabel(label, purpose);
  if (!clean.ok) return { error: clean.error };
  const { member, session } = auth;
  let publicKey: string;
  try {
    ({ publicKey } = await reuseOrGenerateKey(serviceDb(), masterKey(), {
      tenantId: member.tenant_id,
      purpose,
      label: clean.value,
      createdBy: session.accountId,
    }));
  } catch (error) {
    log.error("keys.generate_failed", {
      tenant: member.tenant_id,
      purpose,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { error: "The key could not be created. Try again." };
  }
  revalidatePath(`/console/${member.vault_id}/keys`);
  return purpose === "agent"
    ? addAgentTx(member.vault_id, publicKey, VAULT_DEFAULTS.agentAllowanceYocto, clean.value)
    : setLedgerKeyTx(member.vault_id, publicKey, VAULT_DEFAULTS.ledgerAllowanceYocto);
}

/**
 * Owner only. Sets a pending key aside (pending -> removed, marked discarded): the key the owner never
 * added, or no longer wants to. A sync never makes a discarded key active, even if it later shows up on
 * chain exactly as the vault adds it: the page then shows it as discarded but on chain, and the owner
 * removes it there or keeps it (keepKeyAction). A form action: it answers nothing; the page shows the
 * new status.
 */
export async function discardKeyAction(
  vault: string,
  keyId: string,
  _formData?: FormData,
): Promise<void> {
  const auth = await memberForAction(vault, ["owner"]);
  if (isDenied(auth)) return;
  const { member } = auth;
  try {
    const r = await discardKey(serviceDb(), member.tenant_id, keyId);
    log.info("keys.discarded", { tenant: member.tenant_id, id: r.id, changed: r.changed });
  } catch (error) {
    log.warn("keys.discard_failed", {
      tenant: member.tenant_id,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  revalidatePath(`/console/${member.vault_id}/keys`);
}

/**
 * Owner only. Keeps a key the owner discarded but that is on the vault after all (W-T10-R2): it
 * becomes active only if the chain shows it exactly as the vault adds it, registered (the same full
 * check a sync runs). It always says what happened, also when nothing changed (W-T10-R3).
 */
export async function keepKeyAction(
  vault: string,
  keyId: string,
  _prev: KeepState = null,
  _formData?: FormData,
): Promise<KeepState> {
  const auth = await memberForAction(vault, ["owner"]);
  if (isDenied(auth)) return { ok: false, message: auth.error };
  const { member } = auth;
  try {
    const r = await keepKey(serviceDb(), getReader(), member, keyId);
    log.info("keys.keep", { tenant: member.tenant_id, id: keyId, kept: r.kept, reason: r.reason });
    revalidatePath(`/console/${member.vault_id}/keys`);
    return keepResultText(r);
  } catch (error) {
    log.warn("keys.keep_failed", {
      tenant: member.tenant_id,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false, message: "Not kept: the key could not be checked. Nothing changed." };
  }
}

/** Any member. Re-reads the chain for every key (syncKeyStatuses) and says what changed. */
export async function syncKeysAction(
  vault: string,
  _prev: KeySyncState = null,
  _formData?: FormData,
): Promise<KeySyncState> {
  const auth = await memberForAction(vault);
  if (isDenied(auth)) return { ok: false, ...auth };
  const { member } = auth;
  try {
    const { checks } = await syncKeyStatuses(serviceDb(), getReader(), {
      tenant_id: member.tenant_id,
      vault_id: member.vault_id,
    });
    revalidatePath(`/console/${member.vault_id}/keys`);
    // A stuck ledger key is worded by what this vault's code can do about it (W-T10-R3).
    const ledgerStuck = checks.some(
      (c) => c.purpose === "ledger" && c.reason === "registered_without_key",
    );
    const code: VaultCode = ledgerStuck
      ? await readVaultCode(rpcChainReads(getRpc()), member.vault_id)
      : "unknown";
    const notes = checks.map((c) => describeCheck(c, code)).filter((n): n is string => n !== null);
    const changed = checks.filter((c) => c.to !== c.from).length;
    // Keys in use: pending or active before this sync. Old keys are read too, but only to notice
    // one that is back on the vault.
    const inUse = checks.filter((c) => c.from === "pending" || c.from === "active");
    const unread = inUse.filter((c) => c.reason === "unreadable").length;
    const message =
      inUse.length === 0 && changed === 0
        ? "No pending or active key to check."
        : inUse.length > 0 && unread === inUse.length
          ? "The chain could not be read: every status is unchanged. Try again in a minute."
          : changed === 0
            ? "Checked on chain: nothing changed."
            : `Checked on chain: ${changed} key(s) changed.`;
    return { ok: true, message, notes };
  } catch (error) {
    log.error("keys.sync_failed", {
      tenant: member.tenant_id,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false, error: "The keys could not be checked. Nothing was changed." };
  }
}
