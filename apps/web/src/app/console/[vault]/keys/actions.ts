"use server";

import { revalidatePath } from "next/cache";
import { VAULT_DEFAULTS } from "@/lib/config";
import { isDenied, memberForAction } from "@/lib/console/action-auth";
import { masterKey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import {
  cleanLabel,
  describeCheck,
  isKeyPurpose,
  type KeyPurpose,
  type KeySyncState,
} from "@/lib/keys/rules";
import { generateKey, syncKeyStatuses } from "@/lib/keys/service";
import { log } from "@/lib/log";
import { getReader } from "@/lib/near/server";
import { addAgentTx, setLedgerKeyTx, type WalletTx } from "@/lib/near/tx";

// `vault`, `purpose` and `label` come back from the browser (bound or typed), so `vault` is only a
// lookup key: the tenant and the role come from the membership row (memberForAction → memberForApi),
// and the transaction is built for the member's own vault id. Nothing here ever returns, logs or
// throws a secret: generateKey seals it before it is stored and hands back the public key only.

/**
 * Owner only. Generates a key on the server and returns the transaction the owner signs in their own
 * wallet: `add_agent` for an agent key, `set_ledger_key` for the ledger key, with the PUBLIC key.
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
    ({ publicKey } = await generateKey(serviceDb(), masterKey(), {
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

/** Any member. Re-reads the chain for every pending and active key (syncKeyStatuses) and says what changed. */
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
    const notes = checks.map(describeCheck).filter((n): n is string => n !== null);
    const changed = checks.filter((c) => c.to !== c.from).length;
    const unread = checks.filter((c) => c.reason === "unreadable").length;
    const message =
      checks.length === 0
        ? "No pending or active key to check."
        : unread === checks.length
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
