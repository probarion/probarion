import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildEntry,
  computeBodyHash,
  computeLink,
  type LedgerEntry,
  type LedgerEntryBody,
  nextBodyFields,
  runChecks,
  ZERO_LINK,
} from "@probarion/core";
import { composeBody, FileLedgerStore, LedgerConflictError, LedgerError } from "@probarion/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/port";
import {
  PUBLIC_LEDGER_PAGE,
  type PublicLedgerRow,
  PublicLedgerStore,
  SupabaseLedgerStore,
} from "@/lib/ledger/store";
import { appendBody, testSigner } from "../fixtures/ledger";
import { makeSnapshot } from "../fixtures/snapshot";
import { asRole, freshDb, seedTenant } from "./harness";
import { pgliteDb } from "./pglite-db";

const signer = testSigner();
const json = (e: LedgerEntry): string => JSON.stringify(e);

interface Fixture {
  pg: PGlite;
  service: Db;
  anon: Db;
  /** A tenant of its own, so a test does not depend on what another test appended. */
  tenant(over?: { proofPublic?: boolean }): Promise<{ id: string; vault: string }>;
  count(tenantId: string): Promise<number>;
}

async function fixture(): Promise<Fixture> {
  const pg = await freshDb();
  let n = 0;
  return {
    pg,
    service: pgliteDb(pg),
    anon: pgliteDb(pg, "anon"),
    async tenant(over = {}) {
      n += 1;
      const vault = `t${n}.vaults.probarion.near`;
      const id = await seedTenant(pg, { vault, owner: "acme.near", proofPublic: over.proofPublic });
      return { id, vault };
    },
    async count(tenantId) {
      const r = await pg.query<{ n: number }>(
        "select count(*)::int as n from public.ledger_entries where tenant_id = $1",
        [tenantId],
      );
      return r.rows[0]?.n ?? -1;
    },
  };
}

/** An entry built by core at an explicit position (the store would pick the position itself). */
async function entryAt(
  vault: string,
  seq: number,
  prevLink: string,
  request = "raw",
): Promise<LedgerEntry> {
  return buildEntry(
    composeBody(appendBody(vault, { request_id: request }), seq, prevLink),
    signer.sign,
  );
}

/** The ledger_append payload, as the store sends it. */
function appendArgs(
  tenantId: string,
  e: LedgerEntry,
  expect: { seq: number; prev_link: string } = { seq: e.body.seq, prev_link: e.body.prev_link },
) {
  return {
    tenant_id: tenantId,
    entry: { body_hash: e.body_hash, sig: e.sig, signer: e.signer, link: e.link },
    body_text: JSON.stringify(e.body),
    expect,
  };
}

/**
 * `n` hand-made rows (seq 0..n-1, each with a distinct prev_link and hash), written as the table owner, only to get
 * past a page size cheaply. They are not a valid chain: reads and paging do not care.
 */
async function junkRows(pg: PGlite, tenantId: string, n: number): Promise<void> {
  await pg.query(
    `insert into public.ledger_entries (tenant_id, seq, kind, body, body_hash, sig, signer, link, request_id)
     select $1, i, 'note', jsonb_build_object('seq', i, 'prev_link', md5(i::text) || md5((i + 1000)::text)),
            md5(i::text) || md5((i + 2000)::text), 'ed25519:s', 'ed25519:p', md5(i::text) || md5((i + 3000)::text), 'r'
     from generate_series(0, $2::int - 1) i`,
    [tenantId, n],
  );
}

/** Every `ledger_head` read must finish before any `ledger_append` may start: the interleaving of a race. */
function raceGate(inner: Db, parties: number): { db: Db; headReads(): number } {
  let heads = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const db: Db = {
    async rpc<T>(fn: string, p?: Record<string, unknown>): Promise<T> {
      if (fn === "ledger_append") await opened;
      const out = await inner.rpc<T>(fn, p);
      if (fn === "ledger_head") {
        heads += 1;
        if (heads >= parties) open();
      }
      return out;
    },
  };
  return { db, headReads: () => heads };
}

describe("SupabaseLedgerStore: persistence", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });

  it("persists core-built entries unchanged through jsonb, so core's verifier accepts them (checks a and b)", async () => {
    const { id, vault } = await f.tenant();
    const store = new SupabaseLedgerStore(f.service, id);
    const first = await store.append(appendBody(vault), signer.sign);
    expect(first.body.seq).toBe(0);
    expect(first.body.prev_link).toBe(ZERO_LINK);
    await store.append(
      appendBody(vault, {
        kind: "payment",
        verdict: null,
        decided_by: null,
        refs: { decision_body_hash: first.body_hash },
        contract: { code: null, tx_hash: "tx1", spend_id: 1, status: "paid" },
      }),
      signer.sign,
    );
    await store.append(
      appendBody(vault, { kind: "note", verdict: null, decided_by: null, rules: [] }),
      signer.sign,
    );

    const ledger = await store.all();
    expect(ledger.map((e) => e.body.seq)).toEqual([0, 1, 2]);
    for (const e of ledger) {
      expect(computeBodyHash(e.body)).toBe(e.body_hash); // the round trip must not change the canonical bytes
      expect(computeLink(e.body.prev_link, e.body_hash, e.sig)).toBe(e.link);
    }
    const report = await runChecks(makeSnapshot({ vault, ledger, ledgerKey: signer.publicKey }));
    expect(report.checks.find((c) => c.id === "a")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "b")?.status).toBe("pass");
    expect((await store.head())?.body.seq).toBe(2);
  });

  it("reads back the exact bytes it stored, although jsonb reorders object keys", async () => {
    const { id, vault } = await f.tenant();
    const store = new SupabaseLedgerStore(f.service, id);
    const appended = await store.append(
      appendBody(vault, {
        // Key order that jsonb would not keep (it sorts by length, then bytes), numbers, non-ASCII text.
        refs: { decision_body_hash: "b".repeat(64), anchor_seq: 3 },
        rules: [
          {
            id: "custom.zz-last",
            outcome: "pass",
            detail: "Zürich ✓ 💸 \\u0000 literal backslash",
          },
          { id: "custom.a-first", outcome: "pass", detail: "x" },
        ],
        contract: { tx_hash: "tx", status: "paid", spend_id: 1e21, code: null },
      }),
      signer.sign,
    );
    const stored = await f.pg.query<{ body_text: string; body: string }>(
      "select body_text, body::text as body from public.ledger_entries where tenant_id = $1",
      [id],
    );
    expect(stored.rows[0]?.body_text).toBe(JSON.stringify(appended.body));
    // This is why body_text exists: the jsonb column alone would give different bytes.
    expect(stored.rows[0]?.body).not.toBe(JSON.stringify(appended.body));

    const [read] = await store.all();
    expect(json(read as LedgerEntry)).toBe(json(appended));
    expect(json((await store.head()) as LedgerEntry)).toBe(json(appended));
    expect(json((await store.getByHash(appended.body_hash)) as LedgerEntry)).toBe(json(appended));
  });

  it("finds an entry by body hash, and nothing for an unknown hash", async () => {
    const { id, vault } = await f.tenant();
    const store = new SupabaseLedgerStore(f.service, id);
    const first = await store.append(appendBody(vault), signer.sign);
    expect((await store.getByHash(first.body_hash))?.body.seq).toBe(0);
    expect(await store.getByHash("f".repeat(64))).toBeNull();
  });

  it("returns entries from a seq on, at most 500 at a time", async () => {
    const { id } = await f.tenant();
    await junkRows(f.pg, id, 600); // the chain is irrelevant to this read
    const store = new SupabaseLedgerStore(f.service, id);
    expect((await store.since(0)).map((e) => e.body.seq)).toEqual([...Array(500).keys()]);
    expect((await store.since(500)).map((e) => e.body.seq)).toEqual(
      Array.from({ length: 100 }, (_, i) => 500 + i),
    );
    expect(await store.since(600)).toEqual([]);
    expect((await store.since(0))[3]?.body.seq).toBe(3);
  });
});

describe("SupabaseLedgerStore: parity with the SDK's FileLedgerStore", () => {
  let f: Fixture;
  let dir: string;
  beforeAll(async () => {
    f = await fixture();
    dir = await mkdtemp(join(tmpdir(), "probarion-ledger-parity-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("the same three bodies give byte-identical entries, whether appended or read back", async () => {
    const { id, vault } = await f.tenant();
    const path = join(dir, "ledger.jsonl");
    const file = new FileLedgerStore(path);
    const store = new SupabaseLedgerStore(f.service, id);
    const first = appendBody(vault, {
      evidence: null,
      refs: { decision_body_hash: "c".repeat(64), anchor_seq: 7 },
    });
    const bodies = [
      first,
      appendBody(vault, {
        kind: "payment",
        verdict: null,
        decided_by: null,
        // A field the interface does not have: composeBody drops it for both stores.
        ...({ not_in_the_interface: "x" } as object),
        contract: { code: null, tx_hash: "tx1", spend_id: 1, status: "paid" },
      }),
      appendBody(vault, { kind: "note", verdict: null, decided_by: null, rules: [] }),
    ];
    const fromFile: LedgerEntry[] = [];
    const fromDb: LedgerEntry[] = [];
    for (const body of bodies) {
      fromFile.push(await file.append(body, signer.sign));
      fromDb.push(await store.append(body, signer.sign));
    }
    expect(fromDb.map(json)).toEqual(fromFile.map(json));
    expect((await store.all()).map(json)).toEqual((await file.all()).map(json));
    // The JSONL file is exactly the lines the database ledger would export.
    expect(await readFile(path, "utf8")).toBe(fromDb.map((e) => `${json(e)}\n`).join(""));
    expect(JSON.stringify(fromDb[1]?.body)).not.toContain("not_in_the_interface");

    const verdicts = async (ledger: LedgerEntry[]) =>
      (await runChecks(makeSnapshot({ vault, ledger, ledgerKey: signer.publicKey }))).checks
        .filter((c) => c.id === "a" || c.id === "b")
        .map((c) => [c.id, c.status]);
    expect(await verdicts(await store.all())).toEqual([
      ["a", "pass"],
      ["b", "pass"],
    ]);
    expect(await verdicts(await store.all())).toEqual(await verdicts(await file.all()));
  });

  it("refuses the same unsound inputs as the file store", async () => {
    const { id, vault } = await f.tenant();
    const file = new FileLedgerStore(join(dir, "refuse.jsonl"));
    const store = new SupabaseLedgerStore(f.service, id);
    const wrongSigner = async () => {
      const other = testSigner();
      // A valid signature, but over other bytes than the ones it was asked to sign.
      return other.sign(new Uint8Array(32));
    };
    for (const bad of [
      appendBody(vault, { amount: undefined as unknown as string }), // not plain JSON
    ]) {
      await expect(file.append(bad, signer.sign)).rejects.toThrow();
      await expect(store.append(bad, signer.sign)).rejects.toThrow();
    }
    await expect(file.append(appendBody(vault), wrongSigner)).rejects.toThrow(/does not verify/);
    await expect(store.append(appendBody(vault), wrongSigner)).rejects.toThrow(/does not verify/);
    expect(await f.count(id)).toBe(0);
    expect(await file.all()).toEqual([]);
  });
});

describe("SupabaseLedgerStore: the chain never forks", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });

  it("concurrent appends leave one winner and a LedgerConflictError (Review Focus #2)", async () => {
    const { id, vault } = await f.tenant();
    // Two store instances with their own Db handles, as two serverless invocations would have. Both still run on ONE
    // PGlite backend (one connection, one transaction at a time), so this exercises the logic, not parallel execution.
    const a = new SupabaseLedgerStore(pgliteDb(f.pg), id);
    const b = new SupabaseLedgerStore(pgliteDb(f.pg), id);
    const results = await Promise.allSettled([
      a.append(appendBody(vault, { kind: "note", request_id: "r-a" }), signer.sign),
      b.append(appendBody(vault, { kind: "note", request_id: "r-b" }), signer.sign),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LedgerConflictError);
    const seqs = (await a.all()).map((e) => e.body.seq);
    expect(seqs).toEqual([...seqs.keys()]);
    expect(seqs).toHaveLength(1);
  });

  it("when every writer has read the same head before any writes, exactly one lands (forced interleaving)", async () => {
    const { id, vault } = await f.tenant();
    const writers = 5;
    const gate = raceGate(f.service, writers);
    const stores = Array.from({ length: writers }, () => new SupabaseLedgerStore(gate.db, id));
    const results = await Promise.allSettled(
      stores.map((s, i) =>
        s.append(appendBody(vault, { kind: "note", request_id: `race-${i}` }), signer.sign),
      ),
    );
    const winners = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const losers = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(writers - 1);
    for (const e of losers) {
      expect(e).toBeInstanceOf(LedgerConflictError);
      expect((e as LedgerConflictError).expected).toEqual({ seq: 0, prev_link: ZERO_LINK });
      expect((e as LedgerConflictError).actual).toEqual({ seq: 1, prev_link: winners[0]?.link });
    }
    expect(await f.count(id)).toBe(1);
    // The conflict carries the head position, so a loser needs no second read to report it.
    expect(gate.headReads()).toBe(writers);

    // Each loser retries (as a caller would: re-read, rebuild, append) and the chain stays one line.
    const plain = new SupabaseLedgerStore(f.service, id);
    for (let i = 0; i < losers.length; i++) {
      await plain.append(
        appendBody(vault, { kind: "note", request_id: `retry-${i}` }),
        signer.sign,
      );
    }
    const ledger = await plain.all();
    expect(ledger.map((e) => e.body.seq)).toEqual([0, 1, 2, 3, 4]);
    for (let i = 1; i < ledger.length; i++) {
      expect(ledger[i]?.body.prev_link).toBe(ledger[i - 1]?.link);
    }
    const report = await runChecks(makeSnapshot({ vault, ledger, ledgerKey: signer.publicKey }));
    expect(report.checks.find((c) => c.id === "a")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "b")?.status).toBe("pass");
  });

  it("ledger_append alone refuses a stale seq, a wrong prev_link, a gap and a replay, and writes nothing", async () => {
    const { id, vault } = await f.tenant();
    const store = new SupabaseLedgerStore(f.service, id);
    const e0 = await store.append(appendBody(vault, { request_id: "e0" }), signer.sign);
    const e1 = await store.append(appendBody(vault, { request_id: "e1" }), signer.sign);
    const wrong = "e".repeat(64);

    const refused: [string, ReturnType<typeof appendArgs>][] = [
      // seq 1 again (a stale head: the caller read the ledger before e1 landed)
      ["stale seq", appendArgs(id, await entryAt(vault, 1, e0.link, "stale"))],
      // the right seq on a wrong predecessor: only the prev_link check stops this fork
      ["wrong prev_link", appendArgs(id, await entryAt(vault, 2, wrong, "fork"))],
      // the right entry, but the caller expected the head to be somewhere else
      [
        "expect says seq 1",
        appendArgs(id, await entryAt(vault, 2, e1.link, "e"), { seq: 1, prev_link: e0.link }),
      ],
      [
        "expect has another prev_link",
        appendArgs(id, await entryAt(vault, 2, e1.link, "e2"), { seq: 2, prev_link: wrong }),
      ],
      ["gap", appendArgs(id, await entryAt(vault, 3, e1.link, "gap"))],
      ["a second genesis", appendArgs(id, await entryAt(vault, 0, ZERO_LINK, "genesis"))],
    ];
    for (const [name, args] of refused) {
      await expect(f.service.rpc("ledger_append", args), name).rejects.toMatchObject({
        code: "ledger_conflict",
      });
      expect(await f.count(id), name).toBe(2);
    }
    // The control: the same call with the right position lands.
    const e2 = await entryAt(vault, 2, e1.link, "ok");
    await f.service.rpc("ledger_append", appendArgs(id, e2));
    expect(await f.count(id)).toBe(3);
    // And replaying it (same entry) now conflicts instead of duplicating.
    await expect(f.service.rpc("ledger_append", appendArgs(id, e2))).rejects.toMatchObject({
      code: "ledger_conflict",
    });
    expect(await f.count(id)).toBe(3);
  });

  it("ledger_append refuses an entry that is not at the position it says it expects", async () => {
    const { id, vault } = await f.tenant();
    const e0 = await entryAt(vault, 0, ZERO_LINK, "e0");
    // Head position is (0, ZERO), expect says so, but the entry itself is built for seq 1.
    const e1 = await entryAt(vault, 1, e0.link, "e1");
    await expect(
      f.service.rpc("ledger_append", appendArgs(id, e1, { seq: 0, prev_link: ZERO_LINK })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await f.count(id)).toBe(0);
  });

  it("an insert that loses to a unique key is reported as ledger_conflict, not as a raw duplicate", async () => {
    const { id, vault } = await f.tenant();
    const store = new SupabaseLedgerStore(f.service, id);
    const e0 = await store.append(appendBody(vault, { request_id: "e0" }), signer.sign);
    // The head check passes for this entry (it is at seq 1 on e0's link), but it carries e0's body_hash, so the INSERT
    // itself collides with the unique key (tenant, body_hash). SQL cannot recompute hashes (that is core's job), so a
    // crafted payload is how to reach the INSERT's own failure, which is what a lost race looks like.
    const e1 = await entryAt(vault, 1, e0.link, "e1");
    const err = await f.service
      .rpc("ledger_append", appendArgs(id, { ...e1, body_hash: e0.body_hash }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "ledger_conflict" });
    expect((err as Error).message).toMatch(/the head gives seq 1 on prev_link [0-9a-f]{64}/);
    expect(await f.count(id)).toBe(1);
  });

  it("ledger_append holds a transaction-scoped advisory lock (what serialises two appends of one tenant)", async () => {
    const { id, vault } = await f.tenant();
    const e0 = await entryAt(vault, 0, ZERO_LINK, "lock");
    const advisory = async (q: (sql: string) => Promise<{ rows: { n: number }[] }>) =>
      (
        await q(
          "select count(*)::int as n from pg_locks where locktype = 'advisory' and granted and pid = pg_backend_pid()",
        )
      ).rows[0]?.n;
    const [before, during] = await asRole(f.pg, "service_role", null, async (tx) => {
      const b = await advisory((sql) => tx.query<{ n: number }>(sql));
      await tx.query("select public.ledger_append($1::jsonb)", [
        JSON.stringify(appendArgs(id, e0)),
      ]);
      return [b, await advisory((sql) => tx.query<{ n: number }>(sql))];
    });
    expect(before).toBe(0);
    expect(during).toBe(1);
    expect(await advisory((sql) => f.pg.query<{ n: number }>(sql))).toBe(0); // released at commit
    expect(await f.count(id)).toBe(1);
  });

  it("ledger_append validates its input before it writes", async () => {
    const { id, vault } = await f.tenant();
    const e0 = await entryAt(vault, 0, ZERO_LINK);
    const good = appendArgs(id, e0);
    const cases: [string, Record<string, unknown>][] = [
      ["no tenant", { ...good, tenant_id: undefined }],
      ["tenant not a uuid", { ...good, tenant_id: "not-a-uuid" }],
      ["no body_text", { ...good, body_text: undefined }],
      ["body_text not JSON", { ...good, body_text: "{" }],
      ["body_text not an object", { ...good, body_text: "[]" }],
      ["no expect", { ...good, expect: undefined }],
      ["expect seq not a number", { ...good, expect: { seq: "0", prev_link: ZERO_LINK } }],
      ["expect prev_link not hex", { ...good, expect: { seq: 0, prev_link: "zz" } }],
      ["body_hash not hex", { ...good, entry: { ...good.entry, body_hash: "abc" } }],
      ["link not hex", { ...good, entry: { ...good.entry, link: "G".repeat(64) } }],
      ["no sig", { ...good, entry: { ...good.entry, sig: undefined } }],
      ["no signer", { ...good, entry: { ...good.entry, signer: undefined } }],
      ["no entry", { ...good, entry: undefined }],
    ];
    for (const [name, args] of cases) {
      await expect(f.service.rpc("ledger_append", args), name).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    // An entry for another vault than the tenant's own.
    const other = await entryAt("other.vaults.probarion.near", 0, ZERO_LINK);
    await expect(f.service.rpc("ledger_append", appendArgs(id, other))).rejects.toMatchObject({
      code: "invalid_input",
    });
    // A kind the ledger does not have.
    const odd = await buildEntry(
      composeBody(appendBody(vault, { kind: "weird" as LedgerEntryBody["kind"] }), 0, ZERO_LINK),
      signer.sign,
    );
    await expect(f.service.rpc("ledger_append", appendArgs(id, odd))).rejects.toMatchObject({
      code: "invalid_input",
    });
    // A string with U+0000: core hashes it happily, jsonb cannot hold it.
    const nul = await buildEntry(
      composeBody(appendBody(vault, { request_id: "a\u0000b" }), 0, ZERO_LINK),
      signer.sign,
    );
    await expect(f.service.rpc("ledger_append", appendArgs(id, nul))).rejects.toMatchObject({
      code: "invalid_input",
    });
    // A tenant that does not exist.
    await expect(
      f.service.rpc("ledger_append", appendArgs("00000000-0000-4000-8000-000000000000", e0)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await f.count(id)).toBe(0);
    await f.service.rpc("ledger_append", good); // and the untouched input still works
    expect(await f.count(id)).toBe(1);
  });

  it("append(body, sign, { expect }) is a compare-and-append: a stale position throws LedgerConflictError and writes nothing", async () => {
    const { id, vault } = await f.tenant();
    const store = new SupabaseLedgerStore(f.service, id);
    // The caller reads the position it will build on (as an attested decision does: its nonce binds it).
    const e0 = await store.append(appendBody(vault, { request_id: "e0" }), signer.sign, {
      expect: nextBodyFields(null),
    });
    expect(e0.body.seq).toBe(0);
    const e1 = await store.append(appendBody(vault, { request_id: "e1" }), signer.sign, {
      expect: nextBodyFields(e0),
    });
    expect(e1.body.seq).toBe(1);

    // Same seq, stale head.
    const stale = await store
      .append(appendBody(vault, { request_id: "stale" }), signer.sign, {
        expect: nextBodyFields(e0),
      })
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(LedgerConflictError);
    expect((stale as LedgerConflictError).expected).toEqual({ seq: 1, prev_link: e0.link });
    expect((stale as LedgerConflictError).actual).toEqual({ seq: 2, prev_link: e1.link });
    // Right seq, wrong prev_link.
    await expect(
      store.append(appendBody(vault, { request_id: "fork" }), signer.sign, {
        expect: { seq: 2, prev_link: "d".repeat(64) },
      }),
    ).rejects.toBeInstanceOf(LedgerConflictError);
    // Right prev_link, wrong seq.
    await expect(
      store.append(appendBody(vault, { request_id: "skip" }), signer.sign, {
        expect: { seq: 3, prev_link: e1.link },
      }),
    ).rejects.toBeInstanceOf(LedgerConflictError);
    expect((await store.all()).map((e) => e.body.request_id)).toEqual(["e0", "e1"]);
  });

  it("append never signs for a conflicting position: the signer is not called when expect is stale", async () => {
    const { id, vault } = await f.tenant();
    const store = new SupabaseLedgerStore(f.service, id);
    await store.append(appendBody(vault), signer.sign);
    let signed = 0;
    const counting: typeof signer.sign = (bytes) => {
      signed += 1;
      return signer.sign(bytes);
    };
    await expect(
      store.append(appendBody(vault), counting, { expect: { seq: 0, prev_link: ZERO_LINK } }),
    ).rejects.toBeInstanceOf(LedgerConflictError);
    expect(signed).toBe(0);
  });

  it("an append whose acknowledgement is lost is found again, not repeated", async () => {
    const { id, vault } = await f.tenant();
    const lossy: Db = {
      async rpc<T>(fn: string, p?: Record<string, unknown>): Promise<T> {
        const out = await f.service.rpc<T>(fn, p);
        if (fn === "ledger_append") throw new TypeError("fetch failed"); // committed, but the reply never came
        return out;
      },
    };
    const store = new SupabaseLedgerStore(lossy, id);
    const entry = await store.append(appendBody(vault, { request_id: "once" }), signer.sign);
    expect(entry.body.seq).toBe(0);
    expect(await f.count(id)).toBe(1);

    // When the write did not happen, the failure is reported.
    const down: Db = {
      async rpc<T>(fn: string, p?: Record<string, unknown>): Promise<T> {
        if (fn === "ledger_append") throw new TypeError("fetch failed");
        return f.service.rpc<T>(fn, p);
      },
    };
    await expect(
      new SupabaseLedgerStore(down, id).append(
        appendBody(vault, { request_id: "lost" }),
        signer.sign,
      ),
    ).rejects.toThrow(/fetch failed/);
    expect(await f.count(id)).toBe(1);
  });
});

describe("SupabaseLedgerStore: what it refuses to write", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });

  it("rejects U+0000 anywhere in a body (Postgres jsonb cannot hold it), before anything is signed", async () => {
    const { id, vault } = await f.tenant();
    const store = new SupabaseLedgerStore(f.service, id);
    let signed = 0;
    const counting: typeof signer.sign = (bytes) => {
      signed += 1;
      return signer.sign(bytes);
    };
    const bodies = [
      appendBody(vault, { request_id: "a\u0000b" }),
      appendBody(vault, { rules: [{ id: "custom.x", outcome: "pass", detail: "ok\u0000" }] }),
      appendBody(vault, {
        proposal: { reasoning: "pay\u0000now" } as unknown as LedgerEntryBody["proposal"],
      }),
      appendBody(vault, { refs: { "k\u0000": 1 } as unknown as LedgerEntryBody["refs"] }),
    ];
    for (const body of bodies) {
      const err = await store.append(body, counting).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LedgerError);
      expect((err as Error).message).toMatch(/U\+0000/);
    }
    expect(signed).toBe(0);
    expect(await f.count(id)).toBe(0);
    // A backslash-u0000 TEXT (six characters, no NUL) is fine.
    await store.append(
      appendBody(vault, { rules: [{ id: "custom.x", outcome: "pass", detail: "\\u0000" }] }),
      signer.sign,
    );
    expect(await f.count(id)).toBe(1);
  });

  it("refuses an entry for a vault that is not the tenant's, on an empty and on a non-empty ledger", async () => {
    const { id, vault } = await f.tenant();
    const store = new SupabaseLedgerStore(f.service, id);
    const err = await store
      .append(appendBody("someone.vaults.probarion.near"), signer.sign)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect(await f.count(id)).toBe(0);
    await store.append(appendBody(vault), signer.sign);
    const err2 = await store
      .append(appendBody("someone.vaults.probarion.near"), signer.sign)
      .catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(LedgerError);
    expect((err2 as Error).message).toMatch(new RegExp(vault.replaceAll(".", "\\.")));
    expect(await f.count(id)).toBe(1);
  });

  it("an error code is read from the front of the message: a vault named ledger_conflict.near is invalid_input", async () => {
    const { id, vault } = await f.tenant();
    const store = new SupabaseLedgerStore(f.service, id);
    // An entry for a vault named like an error code, into a tenant whose vault is another one.
    const err = await store.append(appendBody("ledger_conflict.near"), signer.sign).catch((e) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect(err).not.toBeInstanceOf(LedgerConflictError);
    expect((err as Error).message).toMatch(
      /invalid_input: the entry is for vault ledger_conflict\.near/,
    );
    const raw = await entryAt("ledger_conflict.near", 0, ZERO_LINK);
    await expect(f.service.rpc("ledger_append", appendArgs(id, raw))).rejects.toMatchObject({
      code: "invalid_input",
    });
    // And the other way round: a tenant whose own vault has that name.
    const oddId = await seedTenant(f.pg, { vault: "ledger_conflict.near", owner: "acme.near" });
    const odd = new SupabaseLedgerStore(f.service, oddId);
    const err2 = await odd.append(appendBody(vault), signer.sign).catch((e) => e);
    expect(err2).toBeInstanceOf(LedgerError);
    expect(err2).not.toBeInstanceOf(LedgerConflictError);
    expect(await f.count(id)).toBe(0);
    expect(await f.count(oddId)).toBe(0);
  });

  it("refuses to chain onto a head that does not recompute under core", async () => {
    const { id, vault } = await f.tenant();
    // Not an entry the store wrote: a direct insert whose body_hash is not the hash of its body.
    const body = composeBody(appendBody(vault), 0, ZERO_LINK);
    await f.pg.query(
      `insert into public.ledger_entries (tenant_id, seq, kind, body, body_hash, sig, signer, link, request_id)
       values ($1, 0, 'decision', $2::jsonb, $3, $4, $5, $6, 'x')`,
      [id, JSON.stringify(body), "1".repeat(64), "ed25519:s", signer.publicKey, "2".repeat(64)],
    );
    const store = new SupabaseLedgerStore(f.service, id);
    await expect(store.append(appendBody(vault), signer.sign)).rejects.toThrow(
      /not internally consistent/,
    );
    expect(await f.count(id)).toBe(1);
  });

  it("signature, hash and link of what it writes all recompute under core", async () => {
    const { id, vault } = await f.tenant();
    const store = new SupabaseLedgerStore(f.service, id);
    const entry = await store.append(appendBody(vault), signer.sign);
    expect(computeBodyHash(entry.body)).toBe(entry.body_hash);
    expect(computeLink(entry.body.prev_link, entry.body_hash, entry.sig)).toBe(entry.link);
    expect(entry.signer).toBe(signer.publicKey);
    // A signer that returns garbage is stopped by core before the database is called.
    await expect(
      store.append(appendBody(vault, { request_id: "bad" }), async () => ({
        sig: entry.sig, // a real signature, over the first body
        signer: signer.publicKey,
      })),
    ).rejects.toThrow(/does not verify/);
    expect(await f.count(id)).toBe(1);
  });
});

describe("SupabaseLedgerStore: tenant isolation", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });

  it("a store sees only its own tenant's ledger, by hash and by read", async () => {
    const a = await f.tenant();
    const b = await f.tenant();
    const storeA = new SupabaseLedgerStore(f.service, a.id);
    const storeB = new SupabaseLedgerStore(f.service, b.id);
    const ea = await storeA.append(appendBody(a.vault), signer.sign);
    await storeA.append(appendBody(a.vault, { request_id: "a2" }), signer.sign);
    const eb = await storeB.append(appendBody(b.vault), signer.sign);

    expect((await storeA.all()).map((e) => e.body.vault)).toEqual([a.vault, a.vault]);
    expect((await storeB.all()).map((e) => e.body.vault)).toEqual([b.vault]);
    expect(eb.body.seq).toBe(0); // its own chain, not a continuation of A's
    expect(await storeB.getByHash(ea.body_hash)).toBeNull();
    expect(await storeA.getByHash(eb.body_hash)).toBeNull();
    expect((await storeB.since(0)).map((e) => e.body_hash)).toEqual([eb.body_hash]);
    // B's tenant cannot take an entry for A's vault, even though A's vault has a ledger.
    await expect(storeB.append(appendBody(a.vault), signer.sign)).rejects.toBeInstanceOf(
      LedgerError,
    );
    expect(await f.count(a.id)).toBe(2);
    expect(await f.count(b.id)).toBe(1);
  });

  it("a tenant id that is not a uuid is an error, never an empty ledger", async () => {
    const { vault } = await f.tenant();
    const store = new SupabaseLedgerStore(f.service, "not-a-uuid");
    await expect(store.head()).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.all()).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.getByHash("a".repeat(64))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.since(0)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.append(appendBody(vault), signer.sign)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("a tenant that does not exist has an empty ledger and cannot be appended to", async () => {
    const { vault } = await f.tenant();
    const store = new SupabaseLedgerStore(f.service, "00000000-0000-4000-8000-000000000000");
    expect(await store.head()).toBeNull();
    expect(await store.all()).toEqual([]);
    await expect(store.append(appendBody(vault), signer.sign)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("only the service role can call the ledger functions; anon and a signed-in member cannot", async () => {
    const { id, vault } = await f.tenant();
    await new SupabaseLedgerStore(f.service, id).append(appendBody(vault), signer.sign);
    const e = await entryAt(vault, 1, `${"0".repeat(63)}1`);
    const calls: [string, Record<string, unknown>][] = [
      ["ledger_head", { tenant_id: id }],
      ["ledger_all", { tenant_id: id }],
      ["ledger_get", { tenant_id: id, body_hash: "a".repeat(64) }],
      ["ledger_since", { tenant_id: id, from_seq: 0 }],
      ["ledger_append", appendArgs(id, e)],
      ["ledger_tenant", { tenant_id: id }],
    ];
    for (const db of [f.anon, pgliteDb(f.pg, "authenticated", "acme.near")]) {
      for (const [fn, args] of calls) {
        await expect(db.rpc(fn, args), fn).rejects.toThrow(/permission denied/);
      }
    }
    const privileges = await f.pg.query<{ role: string; ok: boolean }>(
      `select r as role, has_function_privilege(r, 'public.ledger_entry_json(public.ledger_entries)', 'execute') as ok
       from unnest(array['anon', 'authenticated', 'service_role']) r`,
    );
    expect(Object.fromEntries(privileges.rows.map((r) => [r.role, r.ok]))).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    });
    await expect(
      asRole(f.pg, "anon", null, (tx) => tx.query("select 1 from public.ledger_entries")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("public proof: anon reads only what the owner made public", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });

  const PUBLIC_KEYS = [
    "body_hash",
    "body_text",
    "created_at",
    "kind",
    "link",
    "seq",
    "sig",
    "signer",
  ];

  it("serves a proof_public vault's ledger to anon, and says nothing about a private or unknown vault", async () => {
    const pub = await f.tenant({ proofPublic: true });
    const priv = await f.tenant({ proofPublic: false });
    for (const t of [pub, priv]) {
      const s = new SupabaseLedgerStore(f.service, t.id);
      await s.append(appendBody(t.vault), signer.sign);
      await s.append(appendBody(t.vault, { request_id: "second" }), signer.sign);
    }

    const open = new PublicLedgerStore(f.anon, pub.vault);
    const served = await open.all();
    expect(served).toHaveLength(2);
    // Same bytes the service-role store reads.
    expect(served.map(json)).toEqual(
      (await new SupabaseLedgerStore(f.service, pub.id).all()).map(json),
    );
    expect((await open.head())?.body.seq).toBe(1);

    const closed = new PublicLedgerStore(f.anon, priv.vault);
    const unknown = new PublicLedgerStore(f.anon, "never-registered.vaults.probarion.near");
    expect(await closed.all()).toEqual([]);
    expect(await closed.head()).toBeNull();
    expect(await closed.vault()).toBeNull();
    // A private vault and a vault that does not exist look the same: no oracle for "is this vault a customer".
    expect(await unknown.all()).toEqual(await closed.all());
    expect(await unknown.vault()).toEqual(await closed.vault());
    expect(await f.anon.rpc("public_ledger", { vault_id: priv.vault })).toEqual(
      await f.anon.rpc("public_ledger", { vault_id: "never-registered.vaults.probarion.near" }),
    );
    expect(await f.anon.rpc("public_vault", { vault_id: priv.vault })).toBeNull();
    expect(
      await f.anon.rpc("public_vault", { vault_id: "never-registered.vaults.probarion.near" }),
    ).toBeNull();
  });

  it("public_vault returns only what /proof needs, and public_ledger rows carry no tenant data", async () => {
    const pub = await f.tenant({ proofPublic: true });
    await new SupabaseLedgerStore(f.service, pub.id).append(appendBody(pub.vault), signer.sign);
    const info = await new PublicLedgerStore(f.anon, pub.vault).vault();
    expect(info).toEqual({
      vault_id: pub.vault,
      network: "mainnet",
      kind: "external",
      display_name: "",
    });
    const rows = await f.anon.rpc<Record<string, unknown>[]>("public_ledger", {
      vault_id: pub.vault,
    });
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(PUBLIC_KEYS);
    // The body travels once, as text; there is no jsonb copy.
    expect(typeof rows[0]?.body_text).toBe("string");
    expect(rows[0]).not.toHaveProperty("body");
  });

  it("pages public_ledger: at most 500 rows a call, from_seq is the cursor, and each row carries the body once", async () => {
    const pub = await f.tenant({ proofPublic: true });
    await junkRows(f.pg, pub.id, 600);
    const page = (p: Record<string, unknown>) =>
      f.anon.rpc<PublicLedgerRow[]>("public_ledger", { vault_id: pub.vault, ...p });
    const seqs = (rows: PublicLedgerRow[]) => rows.map((r) => r.seq);
    expect(seqs(await page({}))).toEqual([...Array(500).keys()]); // the default is the maximum
    expect(await page({ limit: 5000 })).toHaveLength(500); // clamped
    expect(seqs(await page({ limit: 3, from_seq: 10 }))).toEqual([10, 11, 12]);
    expect(seqs(await page({ from_seq: 598 }))).toEqual([598, 599]);
    expect(await page({ from_seq: 600 })).toEqual([]);
    expect(await page({ limit: 0 })).toHaveLength(1); // at least one row
    // Odd paging input never errors: it falls back to the defaults.
    for (const odd of [
      { limit: "abc" },
      { limit: -5 },
      { limit: 1.5 },
      { limit: null },
      { limit: {} },
    ]) {
      expect(await page(odd), JSON.stringify(odd)).toHaveLength(500);
    }
    for (const odd of [
      { from_seq: "x" },
      { from_seq: -3 },
      { from_seq: 2.5 },
      { from_seq: null },
    ]) {
      expect(seqs(await page({ ...odd, limit: 2 })), JSON.stringify(odd)).toEqual([0, 1]);
    }
    // A row made by hand has no body_text: the public row falls back to the jsonb text, still one copy.
    const [row] = await page({ limit: 1 });
    expect(Object.keys(row ?? {}).sort()).toEqual(PUBLIC_KEYS);
    expect(JSON.parse(row?.body_text ?? "null")).toMatchObject({ seq: 0 });
    // Paging does not unlock a private vault.
    const priv = await f.tenant({ proofPublic: false });
    await junkRows(f.pg, priv.id, 3);
    expect(
      await f.anon.rpc("public_ledger", { vault_id: priv.vault, from_seq: 0, limit: 500 }),
    ).toEqual([]);
  });

  it("PublicLedgerStore.all joins the pages in order, and asks for the next page from the last seq", async () => {
    const calls: Record<string, unknown>[] = [];
    const spy: Db = {
      rpc: <T>(fn: string, p?: Record<string, unknown>) => {
        calls.push({ fn, ...p });
        return f.anon.rpc<T>(fn, p);
      },
    };
    for (const [rows, expectedCalls] of [
      [0, 1],
      [100, 1],
      [PUBLIC_LEDGER_PAGE, 2], // a full page may be the last one: it takes one more call to know
      [600, 2],
    ] as const) {
      const pub = await f.tenant({ proofPublic: true });
      await junkRows(f.pg, pub.id, rows);
      calls.length = 0;
      const all = await new PublicLedgerStore(spy, pub.vault).all();
      expect(
        all.map((e) => e.body.seq),
        `${rows} rows`,
      ).toEqual([...Array(rows).keys()]);
      expect(calls, `${rows} rows`).toHaveLength(expectedCalls);
      expect(calls[0]).toMatchObject({
        fn: "public_ledger",
        from_seq: 0,
        limit: PUBLIC_LEDGER_PAGE,
      });
      if (expectedCalls === 2) expect(calls[1]).toMatchObject({ from_seq: 500 });
    }
  });

  it("PublicLedgerStore.all refuses a page that does not advance instead of looping", async () => {
    const stuck = {
      seq: 0,
      body_text: "{}",
      body_hash: "a".repeat(64),
      sig: "ed25519:s",
      signer: "ed25519:p",
      link: "b".repeat(64),
      kind: "note",
      created_at: "2026-11-08T00:00:00Z",
    };
    let calls = 0;
    const loop: Db = {
      rpc: async <T>() => {
        calls += 1;
        return Array.from({ length: PUBLIC_LEDGER_PAGE }, () => stuck) as T;
      },
    };
    await expect(new PublicLedgerStore(loop, "x.near").all()).rejects.toThrow(/does not advance/);
    expect(calls).toBe(2);
  });

  it("follows proof_public in both directions", async () => {
    const t = await f.tenant({ proofPublic: false });
    await new SupabaseLedgerStore(f.service, t.id).append(appendBody(t.vault), signer.sign);
    const store = new PublicLedgerStore(f.anon, t.vault);
    expect(await store.all()).toEqual([]);
    await f.pg.query("update public.tenants set proof_public = true where id = $1", [t.id]);
    expect(await store.all()).toHaveLength(1);
    expect((await store.vault())?.vault_id).toBe(t.vault);
    await f.pg.query("update public.tenants set proof_public = false where id = $1", [t.id]);
    expect(await store.all()).toEqual([]);
    expect(await store.vault()).toBeNull();
  });

  it("answers a missing or odd vault_id with nothing, not an error", async () => {
    for (const p of [
      {},
      { vault_id: null },
      { vault_id: "" },
      { vault_id: 42 },
      { vault_id: "%" },
      { vault_id: "' or true --" },
    ]) {
      expect(await f.anon.rpc("public_ledger", p), JSON.stringify(p)).toEqual([]);
      expect(await f.anon.rpc("public_vault", p), JSON.stringify(p)).toBeNull();
    }
  });

  it("a signed-in member gets the same gating from the public functions (they are not a member path)", async () => {
    const t = await f.tenant({ proofPublic: false });
    await new SupabaseLedgerStore(f.service, t.id).append(appendBody(t.vault), signer.sign);
    const member = pgliteDb(f.pg, "authenticated", "acme.near");
    expect(await member.rpc("public_ledger", { vault_id: t.vault })).toEqual([]);
    expect(await member.rpc("public_vault", { vault_id: t.vault })).toBeNull();
  });

  it("the public store is read-only: append throws, with the interface's arity", async () => {
    const { vault } = await f.tenant({ proofPublic: true });
    const store = new PublicLedgerStore(f.anon, vault);
    await expect(store.append(appendBody(vault), signer.sign)).rejects.toThrow(/read-only/);
    await expect(
      store.append(appendBody(vault), signer.sign, { expect: nextBodyFields(null) }),
    ).rejects.toThrow(/read-only/);
    expect(
      await f.count(
        (
          await f.pg.query<{ id: string }>("select id from public.tenants where vault_id = $1", [
            vault,
          ])
        ).rows[0]?.id ?? "",
      ),
    ).toBe(0);
  });
});

describe("ledger table constraints (F29)", () => {
  let f: Fixture;
  let id: string;
  let vault: string;
  beforeAll(async () => {
    f = await fixture();
    ({ id, vault } = await f.tenant());
    const store = new SupabaseLedgerStore(f.service, id);
    await store.append(appendBody(vault), signer.sign);
    await store.append(appendBody(vault, { request_id: "two" }), signer.sign);
  });

  it("TRUNCATE is refused for every role, the table owner and a cascade from tenants included", async () => {
    // service_role has no TRUNCATE privilege (migration 0001); the owner has, so only the trigger stops it.
    await expect(f.pg.exec("truncate public.ledger_entries")).rejects.toThrow(/ledger_append_only/);
    await expect(f.pg.exec("truncate public.tenants cascade")).rejects.toThrow(
      /ledger_append_only/,
    );
    await expect(
      asRole(f.pg, "service_role", null, (tx) => tx.query("truncate public.ledger_entries")),
    ).rejects.toThrow(/permission denied|ledger_append_only/);
    expect(await f.count(id)).toBe(2);
  });

  it("UPDATE and DELETE are still refused, and the trigger covers both statements", async () => {
    await expect(f.pg.exec("update public.ledger_entries set request_id = 'x'")).rejects.toThrow(
      /ledger_append_only/,
    );
    await expect(f.pg.exec("delete from public.ledger_entries")).rejects.toThrow(
      /ledger_append_only/,
    );
    const triggers = await f.pg.query<{ tgname: string; tgtype: number }>(
      `select tgname, tgtype from pg_trigger
       where tgrelid = 'public.ledger_entries'::regclass and not tgisinternal order by tgname`,
    );
    const names = triggers.rows.map((t) => t.tgname);
    expect(names).toContain("ledger_entries_no_rewrite");
    expect(names).toContain("ledger_entries_no_truncate");
    // tgtype bit 5 (32) is TRUNCATE, bit 1 (1) is ROW level.
    const truncate = triggers.rows.find((t) => t.tgname === "ledger_entries_no_truncate");
    expect((truncate?.tgtype ?? 0) & 32).toBe(32);
    expect((truncate?.tgtype ?? 0) & 1).toBe(0);
  });

  it("no two entries of a tenant can follow the same predecessor, even by a direct insert (a fork is impossible)", async () => {
    const [first] = await new SupabaseLedgerStore(f.service, id).all();
    // seq 7 is not contiguous (the function would refuse it); the point is that the INDEX alone stops a second child.
    await expect(
      f.pg.query(
        `insert into public.ledger_entries (tenant_id, seq, kind, body, body_hash, sig, signer, link, request_id)
         values ($1, 7, 'note', jsonb_build_object('prev_link', $2::text), $3, 'ed25519:s', 'ed25519:p', $3, 'x')`,
        [id, first?.link, "9".repeat(64)],
      ),
    ).rejects.toThrow(/ledger_entries_one_successor/);
    // The same predecessor in ANOTHER tenant is fine (every genesis has prev_link zero).
    const other = await f.tenant();
    await new SupabaseLedgerStore(f.service, other.id).append(appendBody(other.vault), signer.sign);
    expect(await f.count(other.id)).toBe(1);
  });

  it("body_text can only be the text of body", async () => {
    await expect(
      f.pg.query(
        `insert into public.ledger_entries (tenant_id, seq, kind, body, body_text, body_hash, sig, signer, link, request_id)
         values ($1, 8, 'note', '{"a":1}', '{"a":2}', $2, 'ed25519:s', 'ed25519:p', $2, 'x')`,
        [id, "8".repeat(64)],
      ),
    ).rejects.toThrow(/ledger_entries_body_text_is_body/);
  });

  it("service_role cannot write the table itself; ledger_append (security definer, pinned search_path) still lands", async () => {
    const t = await f.tenant();
    const e0 = await entryAt(t.vault, 0, ZERO_LINK, "direct");
    const insert = (tx: { query: (sql: string, p?: unknown[]) => Promise<unknown> }) =>
      tx.query(
        `insert into public.ledger_entries (tenant_id, seq, kind, body, body_hash, sig, signer, link, request_id)
         values ($1, 0, 'note', $2::jsonb, $3, $4, $5, $6, 'x')`,
        [t.id, JSON.stringify(e0.body), e0.body_hash, e0.sig, e0.signer, e0.link],
      );
    await expect(asRole(f.pg, "service_role", null, insert)).rejects.toThrow(/permission denied/);
    await expect(
      asRole(f.pg, "service_role", null, (tx) =>
        tx.query("update public.ledger_entries set request_id = 'x'"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(f.pg, "service_role", null, (tx) => tx.query("delete from public.ledger_entries")),
    ).rejects.toThrow(/permission denied/);
    expect(await f.count(t.id)).toBe(0);

    const privileges = await f.pg.query<{ priv: string; ok: boolean }>(
      `select p as priv, has_table_privilege('service_role', 'public.ledger_entries', p) as ok
       from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p`,
    );
    expect(Object.fromEntries(privileges.rows.map((r) => [r.priv, r.ok]))).toEqual({
      SELECT: true,
      INSERT: false,
      UPDATE: false,
      DELETE: false,
    });
    const fn = await f.pg.query<{ secdef: boolean; cfg: string[] | null }>(
      `select prosecdef as secdef, proconfig as cfg from pg_proc
       where proname = 'ledger_append' and pronamespace = 'public'::regnamespace`,
    );
    expect(fn.rows[0]?.secdef).toBe(true);
    expect(fn.rows[0]?.cfg?.some((c) => c.startsWith("search_path="))).toBe(true);

    // The one way in still works, and the service role still reads what it wrote.
    const store = new SupabaseLedgerStore(f.service, t.id);
    await store.append(appendBody(t.vault), signer.sign);
    expect(await f.count(t.id)).toBe(1);
    expect(await store.all()).toHaveLength(1);
  });

  it("the unique key on (tenant, seq) is still there", async () => {
    await expect(
      f.pg.query(
        `insert into public.ledger_entries (tenant_id, seq, kind, body, body_hash, sig, signer, link, request_id)
         values ($1, 1, 'note', '{}', $2, 'ed25519:s', 'ed25519:p', $2, 'x')`,
        [id, "7".repeat(64)],
      ),
    ).rejects.toThrow(/duplicate key|unique/);
  });
});
