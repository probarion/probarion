import type { Hex32, LedgerEntry, LedgerEntryBody, LedgerSigner } from "@probarion/core";
import { nextBodyFields } from "@probarion/core";
import {
  InMemoryLedgerStore,
  type LedgerAppendBody,
  type LedgerAppendOptions,
  LedgerConflictError,
  LedgerError,
  type LedgerStore,
} from "@probarion/sdk";
import type { Network } from "@/lib/config";
import { type Db, DbError } from "@/lib/db/port";
import type { TenantKind } from "@/lib/db/tenants";

/** A row as the service-role ledger_* functions return it (`ledger_entry_json`). */
export interface LedgerRow {
  seq: number;
  /** The body as jsonb: the same value as `body_text`, but with its object keys in jsonb order. */
  body: LedgerEntryBody;
  /**
   * `JSON.stringify(entry.body)` verbatim, kept for byte parity with the SDK's FileLedgerStore (core hashes
   * `canonicalJson(body)`, which does not depend on key order). Null only for a row inserted by hand.
   */
  body_text: string | null;
  body_hash: string;
  sig: string;
  signer: string;
  link: string;
  kind: string;
  created_at: string;
}

/** A row of `public_ledger`: the body once, as text (no jsonb copy). */
export type PublicLedgerRow = Omit<LedgerRow, "body" | "body_text"> & { body_text: string };

/** What /proof needs to know about a public vault. */
export interface PublicVault {
  vault_id: string;
  network: Network;
  kind: TenantKind;
  display_name: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function toEntry(r: unknown): LedgerEntry {
  if (
    !isObject(r) ||
    typeof r.body_hash !== "string" ||
    typeof r.sig !== "string" ||
    typeof r.signer !== "string" ||
    typeof r.link !== "string" ||
    !(typeof r.body_text === "string" || r.body_text === null || r.body_text === undefined) ||
    !(typeof r.body_text === "string" || isObject(r.body))
  ) {
    throw new LedgerError("the database returned a ledger row that is not an entry");
  }
  // body_text is the body as the SDK serialised it, key order included, so the entry re-serialises to the same line as
  // FileLedgerStore's; the jsonb column is only the fallback for a row made by hand.
  let body: LedgerEntryBody;
  try {
    body = (typeof r.body_text === "string" ? JSON.parse(r.body_text) : r.body) as LedgerEntryBody;
  } catch {
    throw new LedgerError("the database returned a ledger row whose body is not JSON");
  }
  // Same key order as core's buildEntry, so JSON.stringify gives the same line as the SDK's FileLedgerStore.
  return {
    body,
    body_hash: r.body_hash as Hex32,
    sig: r.sig,
    signer: r.signer,
    link: r.link as Hex32,
  };
}

const toEntries = (rows: unknown): LedgerEntry[] => {
  if (!Array.isArray(rows))
    throw new LedgerError("the database returned a ledger that is not a list");
  return rows.map(toEntry);
};

/**
 * Postgres jsonb cannot store U+0000, in a string or in a key. Core would hash such a body without complaint, so
 * the database would be the first to refuse it, after the signature; refuse it here, before anything is signed.
 */
function containsNul(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false; // a cycle is core's to refuse (canonicalJson), not an infinite loop here
  seen.add(value);
  return Array.isArray(value)
    ? value.some((v) => containsNul(v, seen))
    : Object.entries(value).some(([k, v]) => k.includes("\u0000") || containsNul(v, seen));
}

const SDK_WHERE = "the in-memory ledger";
const CONFLICT_DETAIL = /the head gives seq (\d+) on prev_link ([0-9a-f]{64})/;

/**
 * One tenant's ledger on Postgres, as the SDK's `LedgerStore`.
 *
 * `tenantId` MUST come from the session's membership (`memberRole(vault, session.account)`) or from a server job's
 * own tenant row, never from a request body, query string or header: this class runs as the service role, which
 * bypasses RLS, and the ledger_* functions trust the id they are given. A tenant can only ever write entries for its
 * own vault (ledger_append compares the body's vault with `tenants.vault_id`).
 *
 * Nothing here hashes, signs or links: an entry is made by the SDK's append logic (`InMemoryLedgerStore`, which is
 * core's `buildEntry` plus the SDK's body whitelist and chain checks) over the head read from Postgres, so the entry is
 * byte-identical to the one the SDK's `FileLedgerStore` writes for the same input. This class persists it with
 * `ledger_append`, a compare-and-append: if the head moved since it was read, the database raises `ledger_conflict`,
 * writes nothing, and this class throws the SDK's `LedgerConflictError`.
 *
 * Deviation from FileLedgerStore: a body containing U+0000 is refused (`LedgerError`), because jsonb cannot hold it.
 */
export class SupabaseLedgerStore implements LedgerStore {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  async head(): Promise<LedgerEntry | null> {
    const r = await this.db.rpc<LedgerRow | null>("ledger_head", { tenant_id: this.tenantId });
    return r ? toEntry(r) : null;
  }

  async all(): Promise<LedgerEntry[]> {
    return toEntries(await this.db.rpc<LedgerRow[]>("ledger_all", { tenant_id: this.tenantId }));
  }

  async getByHash(bodyHash: string): Promise<LedgerEntry | null> {
    const r = await this.db.rpc<LedgerRow | null>("ledger_get", {
      tenant_id: this.tenantId,
      body_hash: bodyHash,
    });
    return r ? toEntry(r) : null;
  }

  /** At most 500 entries with `seq >= fromSeq`, oldest first (the watcher's cursor read). */
  async since(fromSeq: number): Promise<LedgerEntry[]> {
    return toEntries(
      await this.db.rpc<LedgerRow[]>("ledger_since", {
        tenant_id: this.tenantId,
        from_seq: fromSeq,
      }),
    );
  }

  async append(
    body: LedgerAppendBody,
    sign: LedgerSigner,
    opts: LedgerAppendOptions = {},
  ): Promise<LedgerEntry> {
    if (containsNul(body)) {
      throw new LedgerError(
        "a ledger body cannot contain U+0000 (the character NUL): Postgres jsonb cannot store it. Remove it from the text before it is recorded.",
      );
    }
    const head = await this.head();
    // The SDK's own append over the head we just read: whitelist, chain checks (the head must recompute under core),
    // the opts.expect comparison, signing, and a recomputation of the new entry's hash, signature and link.
    const entry = await this.build(head, body, sign, opts);
    try {
      await this.db.rpc("ledger_append", {
        tenant_id: this.tenantId,
        entry: {
          body_hash: entry.body_hash,
          sig: entry.sig,
          signer: entry.signer,
          link: entry.link,
        },
        body_text: JSON.stringify(entry.body),
        expect: { seq: entry.body.seq, prev_link: entry.body.prev_link },
      });
    } catch (error) {
      return this.failedAppend(error, entry);
    }
    return entry;
  }

  private async build(
    head: LedgerEntry | null,
    body: LedgerAppendBody,
    sign: LedgerSigner,
    opts: LedgerAppendOptions,
  ): Promise<LedgerEntry> {
    try {
      return await new InMemoryLedgerStore(head === null ? [] : [head]).append(body, sign, opts);
    } catch (error) {
      throw this.named(error);
    }
  }

  /** The SDK words its errors for "the in-memory ledger"; say whose ledger it was. */
  private named(error: unknown): unknown {
    const here = `the ledger of tenant ${this.tenantId}`;
    if (error instanceof LedgerConflictError) {
      return new LedgerConflictError(
        error.message.replace(SDK_WHERE, here),
        error.expected,
        error.actual,
      );
    }
    if (error instanceof LedgerError && error.constructor === LedgerError) {
      return new LedgerError(error.message.replace(SDK_WHERE, here));
    }
    return error;
  }

  /** `ledger_append` failed. Decide what the caller must hear; never report success for an entry that is not stored. */
  private async failedAppend(error: unknown, entry: LedgerEntry): Promise<LedgerEntry> {
    if (error instanceof DbError) {
      if (error.code === "ledger_conflict") throw await this.conflict(error, entry);
      if (error.code === "invalid_input") {
        throw new LedgerError(`the database refused the entry: ${error.message}`);
      }
      if (error.code === "not_found") throw error;
    }
    // Anything else (a timeout, a dropped connection) leaves it unknown whether the write was committed. The entry's
    // hash covers its position and content, so if the ledger holds it, it is ours: report success rather than make the
    // caller append the same decision twice. If the read fails too, or finds nothing, report the original failure.
    if (await this.isStored(entry)) return entry;
    throw error;
  }

  private async isStored(entry: LedgerEntry): Promise<boolean> {
    try {
      return (await this.getByHash(entry.body_hash))?.link === entry.link;
    } catch {
      return false;
    }
  }

  private async conflict(error: DbError, entry: LedgerEntry): Promise<LedgerConflictError> {
    const expected = { seq: entry.body.seq, prev_link: entry.body.prev_link };
    const found = CONFLICT_DETAIL.exec(error.message);
    const actual =
      found?.[1] !== undefined && found[2] !== undefined
        ? { seq: Number(found[1]), prev_link: found[2] as Hex32 }
        : nextBodyFields(await this.head());
    return new LedgerConflictError(
      `the ledger of tenant ${this.tenantId}: the ledger moved: this append expected to write seq ${expected.seq} on prev_link ${expected.prev_link}, but the head gives seq ${actual.seq} on prev_link ${actual.prev_link}; nothing was written`,
      expected,
      actual,
    );
  }
}

/** Rows per `public_ledger` call: the function's own maximum (it clamps anything larger). */
export const PUBLIC_LEDGER_PAGE = 500;

/**
 * Anon-key reader for /proof and snapshot.json. Every read goes through the public_* functions, which answer only for
 * a vault whose owner turned `proof_public` on: for a private vault, and for one that does not exist, `all()` is `[]`,
 * `head()` is null and `vault()` is null. Read-only: `append` always throws.
 *
 * `all()` pages through `public_ledger({ vault_id, from_seq, limit })` (at most 500 rows a call, the
 * cursor is the last row's seq + 1) and joins the pages. `head()` reads the whole ledger the same way.
 */
export class PublicLedgerStore implements LedgerStore {
  constructor(
    private readonly db: Db,
    private readonly vaultId: string,
  ) {}

  async vault(): Promise<PublicVault | null> {
    return this.db.rpc<PublicVault | null>("public_vault", { vault_id: this.vaultId });
  }

  async all(): Promise<LedgerEntry[]> {
    const entries: LedgerEntry[] = [];
    let fromSeq = 0;
    for (;;) {
      const rows = await this.db.rpc<PublicLedgerRow[]>("public_ledger", {
        vault_id: this.vaultId,
        from_seq: fromSeq,
        limit: PUBLIC_LEDGER_PAGE,
      });
      entries.push(...toEntries(rows));
      if (rows.length < PUBLIC_LEDGER_PAGE) return entries;
      const last = rows[rows.length - 1]?.seq;
      // The cursor must move on, or a misbehaving server would make this loop for ever.
      if (typeof last !== "number" || last < fromSeq) {
        throw new LedgerError("public_ledger returned a page that does not advance");
      }
      fromSeq = last + 1;
    }
  }

  async head(): Promise<LedgerEntry | null> {
    return (await this.all()).at(-1) ?? null;
  }

  async append(
    _body: LedgerAppendBody,
    _sign: LedgerSigner,
    _opts?: LedgerAppendOptions,
  ): Promise<LedgerEntry> {
    throw new LedgerError("PublicLedgerStore is read-only");
  }
}
