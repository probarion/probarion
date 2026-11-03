import type { AccessKeyState } from "@/lib/near/reader";

// The rules for agent and ledger keys, as pure functions (no database, no chain, no secret), so the
// browser can share the types and the tests can pin every branch.

export type KeyPurpose = "agent" | "ledger";

/**
 * - `pending`: generated and sealed; the owner has not added it on chain yet (or the chain does not
 *   show it as the vault's key yet). Never used.
 * - `active`: the chain shows exactly the key the vault hands out, registered. The only usable state.
 * - `revoked`: the vault stopped accepting it while its access key may still exist (`remove_agent`
 *   or `set_ledger_key` already took it out of the registry), or its permission is no longer the one
 *   the vault hands out.
 * - `removed`: the chain answered, definitively, that the access key is gone (NO_KEY), or the owner
 *   discarded the key while it was pending.
 *
 * `revoked` and `removed` are not final (W-T10-R1): when a later sync sees the full activation
 * state again (the exact scoped key, registered), the key is active again. A transient NO_KEY from a
 * lagging node therefore never sticks, and the chain is always what decides.
 */
export type KeyStatus = "pending" | "active" | "revoked" | "removed";

export function isKeyPurpose(value: unknown): value is KeyPurpose {
  return value === "agent" || value === "ledger";
}

/** The one method each key may call (contracts/vault/src/keys.rs `add_access_key_allowance`). */
export const KEY_METHOD: Readonly<Record<KeyPurpose, string>> = {
  agent: "spend",
  ledger: "anchor",
};

export type ScopeProblem =
  | "missing"
  | "full_access"
  | "gas_key"
  | "not_function_call"
  | "wrong_receiver"
  | "wrong_methods";

/**
 * Null when `key` is exactly what the vault adds for `purpose`: a plain `FunctionCall` key (a gas key
 * is refused even with the right scope), receiver the vault itself, methods exactly `[spend]` or
 * `[anchor]` (an empty list means "any method" on NEAR, so it is refused too).
 */
export function scopeProblem(
  purpose: KeyPurpose,
  vault: string,
  key: AccessKeyState,
): ScopeProblem | null {
  if (!key.exists) return "missing";
  if (key.fullAccess || key.kind === "FullAccess" || key.kind === "GasKeyFullAccess") {
    return "full_access";
  }
  if (key.kind === "GasKeyFunctionCall") return "gas_key";
  if (key.kind !== "FunctionCall") return "not_function_call";
  if (key.receiverId !== vault) return "wrong_receiver";
  if (key.methodNames.length !== 1 || key.methodNames[0] !== KEY_METHOD[purpose]) {
    return "wrong_methods";
  }
  return null;
}

/**
 * What the chain said about one key. `readable: false` means a read failed (transport, node, a view
 * that threw): it says nothing about the key, so it never changes a status. `registered` is "the
 * vault's list_agents has it" for an agent key and "get_config().ledger_key is it" for the ledger key.
 */
export type ChainView =
  | { readable: false }
  | { readable: true; registered: boolean; key: AccessKeyState };

export type CheckReason =
  | "activated"
  | "reactivated"
  | "not_on_chain"
  | "not_registered"
  /** The vault registers the key, but its access key was never added: stuck (W-T10-R1). */
  | "registered_without_key"
  | `scope_${ScopeProblem}`
  | "unreadable"
  | "removed_on_chain"
  | "unregistered"
  | "still_active"
  | "inactive"
  /** On chain exactly as the vault adds it, but the owner discarded it: never made active by a sync (W-T10-R2). */
  | "discarded_on_chain";

export interface Verdict {
  to: KeyStatus;
  reason: CheckReason;
}

/**
 * The next status of one key, from what the chain showed. Pure; the caller writes it compare-and-set.
 * A key goes to `active` only through the one full check (`usable`): the exact scoped key, registered.
 */
export function nextStatus(
  row: { purpose: KeyPurpose; status: KeyStatus; discarded?: boolean },
  vault: string,
  view: ChainView,
): Verdict {
  if (!view.readable) return { to: row.status, reason: "unreadable" };
  const { registered, key } = view;
  const problem = scopeProblem(row.purpose, vault, key);
  const usable = problem === null && registered;
  if (row.status === "active") {
    // A definite NO_KEY first (remove_agent and set_ledger_key delete the key), then the registry.
    if (!key.exists) return { to: "removed", reason: "removed_on_chain" };
    if (!registered) return { to: "revoked", reason: "unregistered" };
    if (problem !== null) return { to: "revoked", reason: `scope_${problem}` };
    return { to: "active", reason: "still_active" };
  }
  // A discarded key stays where it is even then: only the owner's Keep makes it active (W-T10-R2).
  if (usable && row.discarded === true) return { to: row.status, reason: "discarded_on_chain" };
  if (usable)
    return { to: "active", reason: row.status === "pending" ? "activated" : "reactivated" };
  if (!key.exists && registered) return { to: row.status, reason: "registered_without_key" };
  if (row.status !== "pending") return { to: row.status, reason: "inactive" };
  if (!key.exists) return { to: "pending", reason: "not_on_chain" };
  if (problem !== null) return { to: "pending", reason: `scope_${problem}` };
  return { to: "pending", reason: "not_registered" };
}

/** The contract refuses `label.len() > 64` (bytes) in add_agent; the table checks octet_length too. */
export const LABEL_MAX_BYTES = 64;
const DEFAULT_LABEL: Readonly<Record<KeyPurpose, string>> = { agent: "payables", ledger: "ledger" };

export function cleanLabel(
  raw: unknown,
  purpose: KeyPurpose,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "The label must be text." };
  const value = raw.trim();
  if (value === "") return { ok: true, value: DEFAULT_LABEL[purpose] };
  if (/\p{Cc}/u.test(value))
    return { ok: false, error: "The label cannot hold control characters." };
  if (new TextEncoder().encode(value).length > LABEL_MAX_BYTES) {
    return { ok: false, error: `The label is at most ${LABEL_MAX_BYTES} bytes.` };
  }
  return { ok: true, value };
}

/** One key's sync outcome. Public data only: the public key, never anything sealed. */
export interface KeyCheck {
  id: string;
  public_key: string;
  purpose: KeyPurpose;
  from: KeyStatus;
  to: KeyStatus;
  reason: CheckReason;
}

const SCOPE_TEXT: Readonly<Record<ScopeProblem, string>> = {
  missing: "its access key is not on the vault",
  full_access: "the chain shows a full-access key, not a key limited to one method",
  gas_key: "the chain shows a gas key, which the vault never adds",
  not_function_call: "the chain shows a key of an unknown kind",
  wrong_receiver: "the chain shows a key for another contract",
  wrong_methods: "the chain shows a key for other methods",
};

/** A discarded key that is on chain after all (W-T10-R2), worded by what the keys page offers. */
export const DISCARDED_ON_CHAIN_TEXT: Readonly<Record<KeyPurpose, string>> = {
  agent:
    "is on the vault although you discarded it. Remove it from the vault, or Keep it to use it again.",
  ledger:
    "is the vault's ledger key although you discarded it. Keep it to use it again, or generate and set a new ledger key.",
};

/**
 * What the vault's code can do about a stuck ledger key (W-T10-R3):
 *  - `old`: a build from before the contract fix (3dde545 / 64ac3c0). Its set_ledger_key deletes the
 *    old key and adds the new one in ONE batch, so the failed delete of the missing key undoes the add
 *    every time: a stuck ledger key can never be replaced on that vault.
 *  - `current`: any other code identity. set_ledger_key deletes and adds in two independent receipts,
 *    so setting a new ledger key recovers (the delete fails alone, the add lands).
 *  - `unknown`: the vault's code identity could not be read.
 */
export type VaultCode = "old" | "current" | "unknown";

/**
 * The vault builds that cannot replace a stuck ledger key: the two reproducible builds recorded in
 * contracts/code-hashes.json before the set_ledger_key fix (commits 3bd8189 and ba65435).
 */
export const VAULT_CODE_HASHES_WITHOUT_LEDGER_RECOVERY: readonly string[] = [
  "6tbERLAXWjaVKbSNzaivRDh7H9kCcjtmV1qGrgz7entR",
  "54Ne1r9g2Smf2Qtrt9VznmPpEAAHzvK4hbQSJ9voQmuD",
];

/** `identity`: the vault's code identity (global contract hash, else code hash), or null when unread. */
export function vaultCodeOf(identity: string | null | undefined): VaultCode {
  if (typeof identity !== "string" || identity === "") return "unknown";
  return VAULT_CODE_HASHES_WITHOUT_LEDGER_RECOVERY.includes(identity) ? "old" : "current";
}

const STUCK_CAUSE =
  "is registered in the vault but its access key was never added (possibly the vault ran out of NEAR).";

/** The stuck state (W-T10-R1), worded by what can be done about it on the keys page (W-T10-R3). */
export function stuckText(purpose: KeyPurpose, code: VaultCode): string {
  // remove_agent clears the registry even when the access key is missing, so Remove recovers.
  if (purpose === "agent") return `${STUCK_CAUSE} Remove it, then generate a new agent key.`;
  if (code === "old") {
    return `${STUCK_CAUSE} This vault's code cannot replace a stuck ledger key, so anchoring needs a new vault.`;
  }
  if (code === "current") {
    return `${STUCK_CAUSE} Set a new ledger key to recover (Generate ledger key, below); if the vault has no free NEAR, top it up first.`;
  }
  return `${STUCK_CAUSE} The vault's code could not be read, so no new ledger key is offered: reload the page. A vault on the first code release cannot replace a stuck ledger key and needs a new vault; a newer one recovers when you set a new ledger key.`;
}

/**
 * A sentence for a member, or null when there is nothing to say (a healthy key, or a key that is
 * no longer in use and still is not). Every remedy it names is one the keys page offers. `vaultCode`
 * words a stuck ledger key; it does not change anything else.
 */
export function describeCheck(c: KeyCheck, vaultCode: VaultCode = "unknown"): string | null {
  const name = `${c.purpose === "agent" ? "Agent" : "Ledger"} key ${c.public_key.slice(0, 16)}…`;
  const r = c.reason;
  const inUse = c.from === "pending" || c.from === "active";
  if (r === "inactive" || r === "still_active") return null;
  if (r === "activated") return `${name} is active.`;
  if (r === "reactivated")
    return `${name} is on the vault again, limited to its one method: active again.`;
  if (r === "registered_without_key") return `${name} ${stuckText(c.purpose, vaultCode)}`;
  if (r === "discarded_on_chain") return `${name} ${DISCARDED_ON_CHAIN_TEXT[c.purpose]}`;
  if (r === "unreadable") {
    return inUse ? `${name}: the chain could not be read, so its status is unchanged.` : null;
  }
  if (r === "not_on_chain") {
    return `${name} is not on the vault yet. If you signed the transaction, check again in a minute.`;
  }
  if (r === "not_registered") {
    return c.purpose === "agent"
      ? `${name} is not in the vault's agent list, so it stays pending.`
      : `${name} is not the vault's ledger key, so it stays pending.`;
  }
  if (r === "removed_on_chain") return `${name} is gone from the vault: marked removed.`;
  if (r === "unregistered") {
    return `${name} is no longer registered with the vault: marked revoked.`;
  }
  const problem = SCOPE_TEXT[r.slice("scope_".length) as ScopeProblem];
  if (c.to !== "revoked") return `${name} was not activated: ${problem}.`;
  return c.purpose === "agent"
    ? `${name} was revoked: ${problem}. Remove it from the vault (Remove, below).`
    : `${name} was revoked: ${problem}. Set a new ledger key.`;
}

/** What a Keep answers (W-T10-R3): it always says what happened, also when nothing changed. */
export type KeepState = null | { ok: boolean; message: string };

/** The Keep result in words, from keepKey's answer. */
export function keepResultText(r: {
  kept: boolean;
  reason: CheckReason | "not_found" | "not_discarded";
}): KeepState {
  if (r.kept) return { ok: true, message: "Kept: the key is active again." };
  const why = (() => {
    switch (r.reason) {
      case "not_found":
        return "this is not one of this vault's keys";
      case "not_discarded":
        return "the key is not a discarded one, so the next check on chain sets its status";
      case "unreadable":
        return "the chain could not be read; try again in a minute";
      case "registered_without_key":
        return "the vault registers it, but its access key is missing";
      case "not_registered":
      case "inactive":
        return "the vault does not register this key";
      default:
        return r.reason.startsWith("scope_")
          ? SCOPE_TEXT[r.reason.slice("scope_".length) as ScopeProblem]
          : "the chain does not show this key exactly as the vault adds it";
    }
  })();
  return { ok: false, message: `Not kept: ${why}. Nothing changed.` };
}

/** What the "Check on-chain status" form shows. */
export type KeySyncState =
  | null
  | { ok: true; message: string; notes: string[] }
  | { ok: false; error: string; status?: 401 | 403 };
