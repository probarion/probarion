"use server";

import {
  agentEligibility,
  cleanAgentLabel,
  KEY_ERRORS,
  type LedgerBlock,
  ledgerEligibility,
  parsePastedKey,
  type VaultKeyFacts,
} from "@/lib/agent/connect";
import { readKeyFacts } from "@/lib/agent/load";
import type { Session } from "@/lib/auth/session";
import { keyAllowances } from "@/lib/config";
import { isDenied, memberForAction } from "@/lib/console/action-auth";
import { serviceDb } from "@/lib/db/clients";
import type { MemberTenant } from "@/lib/db/tenants";
import { log } from "@/lib/log";
import { getReader } from "@/lib/near/server";
import { addAgentTx, setLedgerKeyTx, type WalletTx } from "@/lib/near/tx";

// The two wallet calls of the Agent (MCP) tab. `vault`, the keys and the label all come back from the browser, so
// none of them is trusted: `vault` only names the vault whose OWNER the caller must be (the membership row decides,
// then the chain's owner must agree), the keys are parsed again and checked against the chain and the tenant's key rows
// as they are now, and the transaction is built for the member's own vault id. These actions write nothing: the keys
// they add belong to the user's agent and have no database row. A pasted value is never logged, returned or thrown.

export type PrepareKeyResult = WalletTx | { error: string; status?: 401 | 403 | 409 };

const SERVER_FAILED =
  "Something went wrong on the server, so nothing was prepared and nothing was signed. Try again in a moment.";
const UNREADABLE =
  "The vault cannot be read right now, so nothing was prepared and nothing was signed. Try again in a moment.";
const NOT_CHAIN_OWNER =
  "The vault's owner on chain is not the account you are signed in as, so the vault would refuse this call.";
const CHANGED =
  "The vault's ledger key changed since this page loaded, so nothing was prepared. Reload the page and check the keys again.";

const BLOCKED: Readonly<Record<LedgerBlock, string>> = {
  hosted_entries:
    "This vault's ledger is written by Probarion's hosted Payables, so its ledger key is not offered. Give the agent a vault of its own.",
  hosted_active:
    "Probarion's hosted Payables holds this vault's ledger key, so a ledger key of your own is not offered. Give the agent a vault of its own.",
  hosted_key:
    "This vault's ledger key was made by Probarion for hosted Payables, so a ledger key of your own is not offered. Give the agent a vault of its own.",
  anchors:
    "This vault's ledger is already anchored on chain by another ledger key, so a second ledger here would fork its history. Give the agent a vault of its own.",
};

/** The owner by role, or the answer that stops here. */
async function owner(vault: unknown) {
  return memberForAction(typeof vault === "string" ? vault : "", ["owner"]);
}

/** The vault's key facts read now, once the chain's owner is the signed-in account; or the answer that stops here. */
async function chainFacts(auth: {
  member: MemberTenant;
  session: Session;
}): Promise<{ stop: { error: string; status?: 403 } } | { facts: VaultKeyFacts }> {
  const { member, session } = auth;
  const read = await readKeyFacts(serviceDb(), getReader(member.network), member);
  if (!read.ok) return { stop: { error: UNREADABLE } };
  // The membership row says owner; the chain says who the contract will accept.
  if (read.config.owner !== session.accountId) {
    return { stop: { error: NOT_CHAIN_OWNER, status: 403 as const } };
  }
  return { facts: read.facts };
}

/**
 * Owner only. The `add_agent` call for the agent key the user's agent made, with the PUBLIC key the browser pasted:
 * `spend()` only, the tenant kind's gas allowance, 1 yoctoNEAR.
 */
export async function prepareAddAgentAction(
  vault: string,
  agentKey: string,
  label: string,
): Promise<PrepareKeyResult> {
  try {
    const auth = await owner(vault);
    if (isDenied(auth)) return auth;
    const key = parsePastedKey(agentKey);
    if (!key.ok) return { error: key.error };
    const clean = cleanAgentLabel(label);
    if (!clean.ok) return { error: clean.error };
    const r = await chainFacts(auth);
    if ("stop" in r) return r.stop;
    const e = agentEligibility(r.facts, key.key);
    if (e.kind === "on_vault") return { error: KEY_ERRORS.onVault };
    if (e.kind === "blocked") return { error: e.error };
    const { member } = auth;
    log.info("agent.add_prepared", { tenant: member.tenant_id, public_key: key.key });
    return addAgentTx(
      member.vault_id,
      key.key,
      keyAllowances(member.kind).agentAllowanceYocto,
      clean.value,
    );
  } catch (e) {
    log.error("agent.prepare_failed", { call: "add_agent", error: errorName(e) });
    return { error: SERVER_FAILED };
  }
}

/**
 * Owner only. The `set_ledger_key` call for the ledger key the user's agent made: `anchor()` only, the tenant kind's
 * gas allowance, 1 yoctoNEAR. Refused for a vault whose ledger another writer keeps. `replace` is what the page
 * asked the owner to confirm: replacing an unused ledger key is prepared only then, and only that key.
 */
export async function prepareSetLedgerKeyAction(
  vault: string,
  ledgerKey: string,
  replace: string | null,
): Promise<PrepareKeyResult> {
  try {
    const auth = await owner(vault);
    if (isDenied(auth)) return auth;
    const key = parsePastedKey(ledgerKey);
    if (!key.ok) return { error: key.error };
    const r = await chainFacts(auth);
    if ("stop" in r) return r.stop;
    const e = ledgerEligibility(r.facts, key.key);
    if (e.kind === "error") return { error: e.error };
    if (e.kind === "blocked") return { error: BLOCKED[e.reason] };
    if (e.kind === "same") return { error: "This key is already the vault's ledger key." };
    if (e.kind === "replace" && replace !== e.current) return { error: CHANGED };
    if (e.kind === "set" && replace !== null) return { error: CHANGED };
    const { member } = auth;
    log.info("agent.ledger_prepared", {
      tenant: member.tenant_id,
      public_key: key.key,
      replaces: e.kind === "replace",
    });
    return setLedgerKeyTx(
      member.vault_id,
      key.key,
      keyAllowances(member.kind).ledgerAllowanceYocto,
    );
  } catch (e) {
    log.error("agent.prepare_failed", { call: "set_ledger_key", error: errorName(e) });
    return { error: SERVER_FAILED };
  }
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown";
}
