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
 *   the vault hands out. Final.
 * - `removed`: the chain answered, definitively, that the access key is gone (NO_KEY). Final.
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
  | "not_on_chain"
  | "not_registered"
  | `scope_${ScopeProblem}`
  | "unreadable"
  | "removed_on_chain"
  | "unregistered"
  | "still_active"
  | "final";

export interface Verdict {
  to: KeyStatus;
  reason: CheckReason;
}

/** The next status of one key, from what the chain showed. Pure; the caller writes it compare-and-set. */
export function nextStatus(
  row: { purpose: KeyPurpose; status: KeyStatus },
  vault: string,
  view: ChainView,
): Verdict {
  if (row.status === "revoked" || row.status === "removed")
    return { to: row.status, reason: "final" };
  if (!view.readable) return { to: row.status, reason: "unreadable" };
  const { registered, key } = view;
  if (row.status === "pending") {
    if (!key.exists) return { to: "pending", reason: "not_on_chain" };
    const problem = scopeProblem(row.purpose, vault, key);
    if (problem !== null) return { to: "pending", reason: `scope_${problem}` };
    if (!registered) return { to: "pending", reason: "not_registered" };
    return { to: "active", reason: "activated" };
  }
  // active: a definite NO_KEY first (remove_agent and set_ledger_key delete the key), then the registry.
  if (!key.exists) return { to: "removed", reason: "removed_on_chain" };
  if (!registered) return { to: "revoked", reason: "unregistered" };
  const problem = scopeProblem(row.purpose, vault, key);
  if (problem !== null) return { to: "revoked", reason: `scope_${problem}` };
  return { to: "active", reason: "still_active" };
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

/** A sentence for a member, or null when there is nothing to say (a healthy or a final key). */
export function describeCheck(c: KeyCheck): string | null {
  const name = `${c.purpose === "agent" ? "Agent" : "Ledger"} key ${c.public_key.slice(0, 16)}…`;
  const r = c.reason;
  if (r === "final" || r === "still_active") return null;
  if (r === "activated") return `${name} is active.`;
  if (r === "unreadable")
    return `${name}: the chain could not be read, so its status is unchanged.`;
  if (r === "not_on_chain") {
    return `${name} is not on the vault yet. If you signed the transaction, check again in a minute.`;
  }
  if (r === "not_registered") {
    return c.purpose === "agent"
      ? `${name} is not in the vault's agent list, so it stays pending.`
      : `${name} is not the vault's ledger key, so it stays pending.`;
  }
  if (r === "removed_on_chain") return `${name} is gone from the vault: marked removed.`;
  if (r === "unregistered")
    return `${name} is no longer registered with the vault: marked revoked.`;
  const problem = SCOPE_TEXT[r.slice("scope_".length) as ScopeProblem];
  return c.to === "revoked"
    ? `${name} was revoked: ${problem}. Remove it from the vault in your wallet.`
    : `${name} was not activated: ${problem}.`;
}

/** What the "Check on-chain status" form shows. */
export type KeySyncState =
  | null
  | { ok: true; message: string; notes: string[] }
  | { ok: false; error: string; status?: 401 | 403 };
