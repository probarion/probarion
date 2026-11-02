// Re-sealing every secret under a new master (spec §11; Task 10 ruling on the rotation). No "server-only"
// import: scripts/rotate-keys.ts runs this from the OWNER's shell. It never logs, and what it returns is
// counts only.
import {
  openAgentSecret,
  openInvoice,
  reencryptAgentSecret,
  reencryptInvoice,
  type SealedSecret,
} from "@/lib/crypto/secrets";
import { DecryptError, type Sealed, sameKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";

interface AgentKeyRow {
  id: string;
  secret_ciphertext: string;
  secret_nonce: string;
  key_version: number;
}

interface InvoiceRow {
  id: string;
  tenant_id: string;
  content_ciphertext: string;
  content_nonce: string;
}

interface RotationRows {
  agent_keys: AgentKeyRow[];
  invoices: InvoiceRow[];
}

/** One table's dry run. Every row is exactly one of rotate, already_new, unreadable or mismatched. */
export interface RotationCounts {
  total: number;
  /** Opens under the old master; re-sealed under the new one and verified to open to the same plaintext. */
  rotate: number;
  /** Already opens under the new master (sealed by the live app after a switch): left as it is. */
  already_new: number;
  /** Opens under neither master. Refuses --apply. */
  unreadable: number;
  /** Re-sealed, but the new ciphertext does not open under the new master to the same plaintext. Refuses --apply. */
  mismatched: number;
}

/** One table after a write, read back from the database. */
export interface AfterCounts {
  total: number;
  new: number;
  /** Still under the old master: sealed by the live app between the read and the switch. Run again after the switch. */
  old: number;
  unreadable: number;
}

export interface RotationReport {
  mode: "dry-run" | "apply";
  /** True when every row either was re-sealed and verified or already opens under the new master. */
  ok: boolean;
  agent_keys: RotationCounts;
  invoices: RotationCounts;
  /** Rows written by the apply; null on a dry run. */
  written: { agent_keys: number; invoices: number } | null;
  /** The state read back after the write; null on a dry run. */
  after: { agent_keys: AfterCounts; invoices: AfterCounts } | null;
}

/** --apply was refused because the dry run was not clean. Nothing was written. */
export class RotationRefusedError extends Error {
  constructor(readonly report: RotationReport) {
    const bad =
      report.agent_keys.unreadable +
      report.invoices.unreadable +
      report.agent_keys.mismatched +
      report.invoices.mismatched;
    super(`rotation_refused: ${bad} row(s) failed the dry run; nothing was written`);
    this.name = "RotationRefusedError";
  }
}

/** The re-seal steps, replaceable only so a test can prove the verification gate. */
export interface RotationCrypto {
  agentSecret: typeof reencryptAgentSecret;
  invoice: typeof reencryptInvoice;
}

export interface RotateOptions {
  /** Write after a clean dry run. Default false: a dry run, which writes nothing. */
  apply?: boolean;
  reencrypt?: Partial<RotationCrypto>;
}

const counts = (): RotationCounts => ({
  total: 0,
  rotate: 0,
  already_new: 0,
  unreadable: 0,
  mismatched: 0,
});

/** Opens with `master`, or null when it does not open (a DecryptError). Anything else is thrown. */
async function tryOpen<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch (error) {
    if (error instanceof DecryptError) return null;
    throw error;
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const invoiceSealed = (r: InvoiceRow): Sealed => ({
  ciphertext: r.content_ciphertext,
  nonce: r.content_nonce,
});

interface Plan {
  report: RotationReport;
  agentKeys: {
    id: string;
    old_ciphertext: string;
    ciphertext: string;
    nonce: string;
    key_version: number;
  }[];
  invoices: { id: string; old_ciphertext: string; ciphertext: string; nonce: string }[];
}

/**
 * The dry run: every row is opened (old master, then new master: trial decryption, since key_version
 * does not say which master sealed a row), re-sealed under the new master in memory, and the new
 * ciphertext is opened again under the new master and compared with the plaintext. Nothing is written.
 */
async function dryRun(
  rows: RotationRows,
  oldMaster: Uint8Array,
  newMaster: Uint8Array,
  c: RotationCrypto,
): Promise<Plan> {
  const plan: Plan = {
    report: {
      mode: "dry-run",
      ok: false,
      agent_keys: counts(),
      invoices: counts(),
      written: null,
      after: null,
    },
    agentKeys: [],
    invoices: [],
  };
  const ak = plan.report.agent_keys;
  for (const row of rows.agent_keys) {
    ak.total += 1;
    try {
      const plain = await tryOpen(() => openAgentSecret(oldMaster, row));
      if (plain === null) {
        if ((await tryOpen(() => openAgentSecret(newMaster, row))) !== null) ak.already_new += 1;
        else ak.unreadable += 1;
        continue;
      }
      let s: SealedSecret | null = null;
      try {
        s = await c.agentSecret(oldMaster, newMaster, row);
      } catch {
        s = null;
      }
      const back =
        s === null
          ? null
          : await tryOpen(() =>
              openAgentSecret(newMaster, {
                secret_ciphertext: s.ciphertext,
                secret_nonce: s.nonce,
              }),
            );
      if (s === null || back !== plain || !(s.key_version > row.key_version)) {
        ak.mismatched += 1;
        continue;
      }
      plan.agentKeys.push({
        id: row.id,
        old_ciphertext: row.secret_ciphertext,
        ciphertext: s.ciphertext,
        nonce: s.nonce,
        key_version: s.key_version,
      });
      ak.rotate += 1;
    } catch {
      // Anything else (a malformed row, a bad key_version) fails the row: --apply is refused.
      ak.unreadable += 1;
    }
  }
  const inv = plan.report.invoices;
  for (const row of rows.invoices) {
    inv.total += 1;
    try {
      const plain = await tryOpen(() => openInvoice(oldMaster, row.tenant_id, invoiceSealed(row)));
      if (plain === null) {
        const asNew = await tryOpen(() =>
          openInvoice(newMaster, row.tenant_id, invoiceSealed(row)),
        );
        if (asNew !== null) inv.already_new += 1;
        else inv.unreadable += 1;
        continue;
      }
      let s: Sealed | null = null;
      try {
        s = await c.invoice(oldMaster, newMaster, row.tenant_id, invoiceSealed(row));
      } catch {
        s = null;
      }
      const back =
        s === null ? null : await tryOpen(() => openInvoice(newMaster, row.tenant_id, s));
      if (s === null || back === null || !sameBytes(back, plain)) {
        inv.mismatched += 1;
        continue;
      }
      plan.invoices.push({
        id: row.id,
        old_ciphertext: row.content_ciphertext,
        ciphertext: s.ciphertext,
        nonce: s.nonce,
      });
      inv.rotate += 1;
    } catch {
      inv.unreadable += 1;
    }
  }
  const bad = ak.unreadable + ak.mismatched + inv.unreadable + inv.mismatched;
  plan.report.ok = bad === 0;
  return plan;
}

async function readBack(
  db: Db,
  oldMaster: Uint8Array,
  newMaster: Uint8Array,
): Promise<NonNullable<RotationReport["after"]>> {
  const rows = await db.rpc<RotationRows>("key_rotation_rows", {});
  const after = (): AfterCounts => ({ total: 0, new: 0, old: 0, unreadable: 0 });
  const out = { agent_keys: after(), invoices: after() };
  const tally = async (c: AfterCounts, open: (m: Uint8Array) => Promise<unknown>) => {
    c.total += 1;
    if ((await tryOpen(() => open(newMaster)).catch(() => null)) !== null) c.new += 1;
    else if ((await tryOpen(() => open(oldMaster)).catch(() => null)) !== null) c.old += 1;
    else c.unreadable += 1;
  };
  for (const r of rows.agent_keys) await tally(out.agent_keys, (m) => openAgentSecret(m, r));
  for (const r of rows.invoices) {
    await tally(out.invoices, (m) => openInvoice(m, r.tenant_id, invoiceSealed(r)));
  }
  return out;
}

/**
 * Re-seals every agent key and every retained invoice from `oldMaster` to `newMaster`.
 *
 * Default: a dry run, which verifies every row in memory and writes nothing. With `apply`, the same
 * dry run runs first in this process, and the write happens only when it was clean for every row;
 * otherwise `RotationRefusedError` (with the counts) and nothing is written. The write itself is one
 * atomic `key_rotation_apply`, compare-and-set on each row's old ciphertext. After it, every row is read
 * back and counted by the master that opens it.
 *
 * Equal masters are refused before anything is read. This never generates a master: losing the new one
 * after an apply loses every secret, so the OWNER stores it first (docs/ops/key-rotation.md).
 */
export async function rotateAll(
  db: Db,
  oldMaster: Uint8Array,
  newMaster: Uint8Array,
  opts: RotateOptions = {},
): Promise<RotationReport> {
  if (await sameKey(oldMaster, newMaster)) {
    throw new Error("old and new master keys are identical: rotation needs a different key");
  }
  const crypto: RotationCrypto = {
    agentSecret: opts.reencrypt?.agentSecret ?? reencryptAgentSecret,
    invoice: opts.reencrypt?.invoice ?? reencryptInvoice,
  };
  const rows = await db.rpc<RotationRows>("key_rotation_rows", {});
  const plan = await dryRun(rows, oldMaster, newMaster, crypto);
  if (!opts.apply) return plan.report;
  if (!plan.report.ok) throw new RotationRefusedError({ ...plan.report, mode: "apply" });

  const written = await db.rpc<{ agent_keys: number; invoices: number }>("key_rotation_apply", {
    agent_keys: plan.agentKeys,
    invoices: plan.invoices,
  });
  return {
    ...plan.report,
    mode: "apply",
    written: { agent_keys: written.agent_keys, invoices: written.invoices },
    // The write is done: a failed read-back must not hide that (null = not counted; run a dry run).
    after: await readBack(db, oldMaster, newMaster).catch(() => null),
  };
}
