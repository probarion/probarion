import { agentList } from "@/lib/agent/connect";
import type { Read } from "@/lib/console/vaults";
import type { Db } from "@/lib/db/port";
import { listKeys } from "@/lib/keys/service";
import { log } from "@/lib/log";

/**
 * Whether the console holds an active agent key and an active ledger key for the tenant: what Payables needs before
 * it runs an invoice (a key only becomes active once Keys sees it on the vault). A failed read is a failed read,
 * never "no keys".
 */
export async function readKeyReadiness(
  db: Db,
  tenantId: string,
): Promise<Read<{ agent: boolean; ledger: boolean }>> {
  return (await readKeySteps(db, tenantId)).readiness;
}

/**
 * The checklist's keys step, from one read of the key rows: whether the console holds both hosted keys active, and
 * the public key of every row (any status), which the chain's keys are matched against for the user's own agent.
 */
export async function readKeySteps(
  db: Db,
  tenantId: string,
): Promise<{ readiness: Read<{ agent: boolean; ledger: boolean }>; known: Read<string[]> }> {
  try {
    const rows = await listKeys(db, tenantId);
    const active = rows.filter((k) => k.status === "active");
    return {
      readiness: {
        ok: true,
        value: {
          agent: active.some((k) => k.purpose === "agent"),
          ledger: active.some((k) => k.purpose === "ledger"),
        },
      },
      known: { ok: true, value: rows.map((k) => k.public_key) },
    };
  } catch {
    log.warn("console.read_failed", { what: "agent_key_list", tenant: tenantId });
    return { readiness: { ok: false, kind: "error" }, known: { ok: false, kind: "error" } };
  }
}

/**
 * Whether the user's own agent holds both keys: the vault's ledger key and at least one agent key are on chain, and
 * neither has a key row here (the Agent (MCP) tab adds such keys). A failed read is a failed read, never "no".
 */
export function selfHeldKeys(
  known: Read<string[]>,
  ledgerKey: string | null,
  agents: Read<unknown>,
): Read<boolean> {
  if (!known.ok) return known;
  const rows = new Set(known.value);
  if (ledgerKey === null || rows.has(ledgerKey)) return { ok: true, value: false };
  if (!agents.ok) return agents;
  const list = agentList(agents.value);
  if (list === null) return { ok: false, kind: "rpc" };
  return { ok: true, value: list.some((a) => !rows.has(a.public_key)) };
}
