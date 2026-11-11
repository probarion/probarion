import "server-only";
import type { AnchorView, VaultConfig } from "@probarion/core";
import {
  agentList,
  type KeyAccess,
  type OutsideKey,
  type VaultKeyFacts,
} from "@/lib/agent/connect";
import { mandateState } from "@/lib/console/mandates-view";
import { type ChainReads, isVaultConfig } from "@/lib/console/vaults";
import type { Db } from "@/lib/db/port";
import { listKeys } from "@/lib/keys/list";
import { type KeyPurpose, scopeProblem } from "@/lib/keys/rules";
import { SupabaseLedgerStore } from "@/lib/ledger/store";
import { log } from "@/lib/log";
import { chainErrorKind, listAll, type VaultReader } from "@/lib/near/reader";
import { freeNearYocto } from "@/lib/near/runway";

// What the Agent (MCP) tab and its two actions read: the chain's view of the vault's keys, and the tenant's own key
// rows and hosted ledger. Reads only: nothing here writes the database or the chain, and no read opens a key (the key
// rows come from agent_key_list, metadata only).

/** A part that could not be read is named, never taken for empty. */
export type FactsPart = "config" | "agents" | "anchors" | "keys" | "ledger";
export type KeyFactsRead =
  | { ok: true; config: VaultConfig; facts: VaultKeyFacts }
  | { ok: false; part: FactsPart };

async function attempt<T>(
  part: string,
  vault: string,
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    log.warn("agent.read_failed", { part, vault, kind: chainErrorKind(e) ?? "error" });
    return { ok: false };
  }
}

function firstSigner(value: unknown): string | null | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return null;
  const first = value[0] as Partial<AnchorView> | undefined;
  return typeof first?.ledger_key === "string" && first.ledger_key !== ""
    ? first.ledger_key
    : undefined;
}

/**
 * The facts the eligibility rules need, read now: `get_config`, `list_agents`, `list_anchors(0, 1)`, the tenant's key
 * rows and its hosted ledger's head. Any part that fails makes the whole read fail (named), as no rule may run on a
 * guess.
 */
export async function readKeyFacts(
  db: Db,
  reader: VaultReader,
  member: { tenant_id: string; vault_id: string },
): Promise<KeyFactsRead> {
  const vault = member.vault_id;
  const [config, agents, anchors, keys, head] = await Promise.all([
    attempt("config", vault, () => reader.getConfig(vault)),
    attempt("agents", vault, () => reader.listAgents(vault)),
    attempt("anchors", vault, () => reader.listAnchors(vault, 0, 1)),
    attempt("keys", vault, () => listKeys(db, member.tenant_id)),
    attempt("ledger", vault, () => new SupabaseLedgerStore(db, member.tenant_id).head()),
  ]);
  if (!config.ok || !isVaultConfig(config.value)) return { ok: false, part: "config" };
  const list = agents.ok ? agentList(agents.value) : null;
  if (list === null) return { ok: false, part: "agents" };
  const signer = anchors.ok ? firstSigner(anchors.value) : undefined;
  if (signer === undefined) return { ok: false, part: "anchors" };
  if (!keys.ok || !Array.isArray(keys.value)) return { ok: false, part: "keys" };
  if (!head.ok) return { ok: false, part: "ledger" };
  const rows = keys.value;
  return {
    ok: true,
    config: config.value,
    facts: {
      agents: list,
      ledgerKey: config.value.ledger_key,
      firstAnchorSigner: signer,
      hostedKeys: rows.map((r) => r.public_key),
      hostedLedgerActive: rows.some((r) => r.purpose === "ledger" && r.status === "active"),
      hostedLedgerEntries: head.value === null ? 0 : head.value.body.seq + 1,
    },
  };
}

async function keyAccess(
  reader: VaultReader,
  vault: string,
  purpose: KeyPurpose,
  publicKey: string,
): Promise<KeyAccess> {
  try {
    const k = await reader.accessKey(vault, publicKey);
    const problem = scopeProblem(purpose, vault, k);
    if (problem === "missing") return { state: "missing" };
    if (problem !== null) return { state: "wrong_scope" };
    return { state: "scoped", allowanceYocto: k.allowance };
  } catch (e) {
    log.warn("agent.read_failed", {
      part: "access_key",
      vault,
      kind: chainErrorKind(e) ?? "error",
    });
    return { state: "unavailable" };
  }
}

export interface AgentPageData {
  facts: KeyFactsRead;
  /** Agent keys on the vault with no key row, and the ledger key when it has none. Empty when facts did not read. */
  outsideAgents: OutsideKey[];
  outsideLedger: OutsideKey | null;
  /** The agent key of every active, in-date mandate; null when the mandates could not be read. */
  activeMandateKeys: string[] | null;
  /** The vault's balance of the network's USDC, base units; null when it could not be read or is another token. */
  usdc: string | null;
  /** NEAR left after storage, yocto; null when the account could not be read. */
  freeNear: string | null;
}

/** Everything the Agent (MCP) page shows, each extra part read on its own after the facts. */
export async function loadAgentPage(
  db: Db,
  reader: VaultReader,
  chain: Pick<ChainReads, "viewAccount">,
  member: { tenant_id: string; vault_id: string },
  networkUsdc: string,
  nowMs: number,
): Promise<AgentPageData> {
  const vault = member.vault_id;
  const facts = await readKeyFacts(db, reader, member);
  if (!facts.ok) {
    return {
      facts,
      outsideAgents: [],
      outsideLedger: null,
      activeMandateKeys: null,
      usdc: null,
      freeNear: null,
    };
  }
  const { config } = facts;
  const hosted = new Set(facts.facts.hostedKeys);
  const outside = facts.facts.agents.filter((a) => !hosted.has(a.public_key));
  const ledgerKey = config.ledger_key;
  const [outsideAgents, outsideLedger, mandates, usdc, account] = await Promise.all([
    Promise.all(
      outside.map(
        async (a): Promise<OutsideKey> => ({
          public_key: a.public_key,
          label: a.label,
          access: await keyAccess(reader, vault, "agent", a.public_key),
        }),
      ),
    ),
    ledgerKey !== null && !hosted.has(ledgerKey)
      ? keyAccess(reader, vault, "ledger", ledgerKey).then(
          (access): OutsideKey => ({ public_key: ledgerKey, label: "", access }),
        )
      : Promise.resolve(null),
    attempt("mandates", vault, () =>
      listAll((from, limit) => reader.listMandates(vault, from, limit)),
    ),
    config.usdc === networkUsdc
      ? attempt("usdc", vault, () => reader.ftBalance(config.usdc, vault))
      : Promise.resolve({ ok: false as const }),
    attempt("account", vault, () => chain.viewAccount(vault)),
  ]);
  return {
    facts,
    outsideAgents,
    outsideLedger,
    activeMandateKeys: mandates.ok
      ? mandates.value.filter((m) => mandateState(m, nowMs).key === "active").map((m) => m.agent_pk)
      : null,
    usdc: usdc.ok && /^(0|[1-9][0-9]*)$/.test(usdc.value) ? usdc.value : null,
    freeNear: account.ok ? freeNearYocto(account.value).toString() : null,
  };
}
