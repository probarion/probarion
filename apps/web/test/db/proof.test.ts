import type { PGlite } from "@electric-sql/pglite";
import type { LedgerStore } from "@probarion/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, DbError } from "@/lib/db/port";
import { PublicLedgerStore, SupabaseLedgerStore } from "@/lib/ledger/store";
import { ProofEvidenceError } from "@/lib/proof/evidence";
import {
  clearProofCache,
  loadLedger,
  loadProof,
  type ProofDeps,
  publicDemoTarget,
} from "@/lib/proof/service";
import { appendBody, testSigner } from "../fixtures/ledger";
import { makeSnapshot } from "../fixtures/snapshot";
import { freshDb, seedTenant } from "./harness";
import { pgliteDb } from "./pglite-db";

const PUBLIC = "demo.vaults.probarion.near";
const PRIVATE = "secret.vaults.probarion.near";

/** A Db that records the functions it was asked to call. */
function counted(db: Db, calls: string[]): Db {
  return {
    rpc: <T>(fn: string, p?: Record<string, unknown>) => {
      calls.push(fn);
      return db.rpc<T>(fn, p);
    },
  };
}

describe("loadProof", () => {
  let pg: PGlite;
  const signer = testSigner();
  beforeAll(async () => {
    pg = await freshDb();
    const pub = await seedTenant(pg, {
      vault: PUBLIC,
      owner: "probarion.near",
      kind: "team",
      proofPublic: true,
    });
    const priv = await seedTenant(pg, {
      vault: PRIVATE,
      owner: "s.near",
      approvers: ["cfo.near"],
      proofPublic: false,
    });
    await new SupabaseLedgerStore(pgliteDb(pg), pub).append(appendBody(PUBLIC), signer.sign);
    await new SupabaseLedgerStore(pgliteDb(pg), priv).append(appendBody(PRIVATE), signer.sign);
  });
  afterAll(async () => {
    await pg.close();
  });
  /** Lines the service logs (proof.unavailable); kept off the test output and asserted where they matter. */
  let warned: string[] = [];
  beforeEach(() => {
    clearProofCache();
    warned = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warned.push(String(line));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const deps = (account: string | null, over: Partial<ProofDeps> = {}) => {
    const publicCalls: string[] = [];
    const serviceCalls: string[] = [];
    const stores: LedgerStore[] = [];
    const makeReader = vi.fn((vault: string, store: LedgerStore) => {
      stores.push(store);
      return {
        snapshot: async () =>
          makeSnapshot({ vault, ledger: await store.all(), ledgerKey: signer.publicKey }),
      };
    });
    const d: ProofDeps = {
      network: "mainnet",
      publicDb: counted(pgliteDb(pg, "anon"), publicCalls),
      serviceDb: counted(pgliteDb(pg), serviceCalls),
      sessionAccount: account,
      makeReader,
      ...over,
    };
    return { d, makeReader, publicCalls, serviceCalls, stores };
  };

  it("serves a public vault to anyone, through the anon key only, and runs the checks", async () => {
    const { d, publicCalls, serviceCalls, stores } = deps(null);
    d.now = () => Date.parse("2026-11-09T10:00:00.000Z");
    const r = await loadProof(d, PUBLIC);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r).toMatchObject({
      vault: PUBLIC,
      network: "mainnet",
      kind: "team",
      audience: "public",
    });
    expect(r.snapshot.ledger).toHaveLength(1);
    expect(r.report.checks.find((c) => c.id === "a")?.status).toBe("pass");
    expect(r.report.generated_at).toBe("2026-11-09T10:00:00.000Z");
    expect(stores[0]).toBeInstanceOf(PublicLedgerStore);
    expect(publicCalls).toEqual(["public_vault", "public_ledger"]);
    expect(serviceCalls).toEqual([]);
  });

  it("hides a private vault from strangers and shows it to members", async () => {
    expect((await loadProof(deps(null).d, PRIVATE)).status).toBe("not_found");
    expect((await loadProof(deps("mallory.near").d, PRIVATE)).status).toBe("not_found");
    for (const member of ["s.near", "cfo.near"]) {
      clearProofCache();
      const { d, stores } = deps(member);
      const r = await loadProof(d, PRIVATE);
      expect(r.status, member).toBe("ok");
      if (r.status !== "ok") continue;
      expect(r.audience).toBe("member");
      expect(r.snapshot.ledger).toHaveLength(1);
      expect(stores[0]).toBeInstanceOf(SupabaseLedgerStore);
    }
  });

  it("answers not_found for a vault nobody registered, to members and strangers alike", async () => {
    expect((await loadProof(deps(null).d, "nobody.vaults.probarion.near")).status).toBe(
      "not_found",
    );
    expect((await loadProof(deps("s.near").d, "nobody.vaults.probarion.near")).status).toBe(
      "not_found",
    );
  });

  it("refuses a vault id that is not a NEAR account before any database call", async () => {
    for (const bad of ["../etc", "Secret.Vaults", "a", "x/y", `${PUBLIC}\n`, ""]) {
      const { d, publicCalls, serviceCalls, makeReader } = deps("s.near");
      expect((await loadProof(d, bad)).status, bad).toBe("not_found");
      expect(publicCalls).toEqual([]);
      expect(serviceCalls).toEqual([]);
      expect(makeReader).not.toHaveBeenCalled();
    }
  });

  it("serves only vaults of the network this deployment reads", async () => {
    const { d, makeReader } = deps("s.near", { network: "testnet" });
    expect((await loadProof(d, PUBLIC)).status).toBe("not_found");
    expect((await loadProof(d, PRIVATE)).status).toBe("not_found");
    expect(makeReader).not.toHaveBeenCalled();
  });

  it("does not take another vault's public row for this one", async () => {
    const { d } = deps(null);
    const real = d.publicDb;
    d.publicDb = {
      rpc: async <T>(fn: string, p?: Record<string, unknown>) =>
        fn === "public_vault"
          ? ({ vault_id: PUBLIC, network: "mainnet", kind: "team", display_name: "demo" } as T)
          : real.rpc<T>(fn, p),
    };
    expect((await loadProof(d, PRIVATE)).status).toBe("not_found");
  });

  it("caches for 60 s per vault and audience", async () => {
    const { d, makeReader } = deps(null);
    let t = 1_000_000;
    d.now = () => t;
    await loadProof(d, PUBLIC);
    t += 59_999;
    await loadProof(d, PUBLIC);
    expect(makeReader).toHaveBeenCalledTimes(1);
    t += 1;
    await loadProof(d, PUBLIC);
    expect(makeReader).toHaveBeenCalledTimes(2);
    // A member of the private vault is another audience, with its own entry.
    const m = deps("s.near");
    m.d.now = () => t;
    await loadProof(m.d, PRIVATE);
    await loadProof(m.d, PRIVATE);
    expect(m.makeReader).toHaveBeenCalledTimes(1);
  });

  it("checks who may see a vault before it looks in the cache", async () => {
    const member = deps("s.near");
    expect((await loadProof(member.d, PRIVATE)).status).toBe("ok");
    expect((await loadProof(deps(null).d, PRIVATE)).status).toBe("not_found");
    expect((await loadProof(deps("mallory.near").d, PRIVATE)).status).toBe("not_found");

    // A vault whose owner turns its proof page off is hidden at once, cache or not.
    expect((await loadProof(deps(null).d, PUBLIC)).status).toBe("ok");
    await pg.query("update public.tenants set proof_public = false where vault_id = $1", [PUBLIC]);
    try {
      expect((await loadProof(deps(null).d, PUBLIC)).status).toBe("not_found");
    } finally {
      await pg.query("update public.tenants set proof_public = true where vault_id = $1", [PUBLIC]);
    }
  });

  it("shows an error, never a pass, when the evidence file is malformed, and caches nothing", async () => {
    const broken = deps(null, {
      makeReader: vi.fn(() => {
        throw new ProofEvidenceError("the file is not a JSON object");
      }),
    });
    expect(await loadProof(broken.d, PUBLIC)).toEqual({
      status: "error",
      reason: "evidence",
      vault: PUBLIC,
      network: "mainnet",
    });
    expect(warned.map((l) => JSON.parse(l))).toMatchObject([
      {
        msg: "proof.unavailable",
        reason: "evidence",
        error: "content/proof-evidence.json: the file is not a JSON object",
      },
    ]);
    const { d, makeReader } = deps(null);
    expect((await loadProof(d, PUBLIC)).status).toBe("ok");
    expect(makeReader).toHaveBeenCalledTimes(1);
  });

  it("shows an error when the chain cannot be read, and caches nothing", async () => {
    const down = deps(null, {
      makeReader: vi.fn(() => ({
        snapshot: async () => {
          throw new Error("query: all 1 RPC endpoint(s) failed");
        },
      })),
    });
    expect(await loadProof(down.d, PUBLIC)).toEqual({
      status: "error",
      reason: "chain",
      vault: PUBLIC,
      network: "mainnet",
    });
    expect(warned.map((l) => JSON.parse(l))).toMatchObject([
      { msg: "proof.unavailable", reason: "chain" },
    ]);
    expect((await loadProof(deps(null).d, PUBLIC)).status).toBe("ok");
  });

  it("says the ledger could not be read when the public ledger is malformed or the database fails", async () => {
    for (const [why, answer] of [
      ["a row that is not an entry", async () => [{ seq: 0 }]],
      [
        "a row whose body is not JSON",
        async () => [
          { seq: 0, body_text: "{not json", body_hash: "h", sig: "s", signer: "k", link: "l" },
        ],
      ],
      [
        "a database error",
        async () => {
          throw new DbError("db_error", "connection reset");
        },
      ],
    ] as const) {
      clearProofCache();
      const { d } = deps(null);
      const real = d.publicDb;
      d.publicDb = {
        rpc: async <T>(fn: string, p?: Record<string, unknown>) =>
          fn === "public_ledger" ? ((await answer()) as T) : real.rpc<T>(fn, p),
      };
      expect(await loadProof(d, PUBLIC), why).toEqual({
        status: "error",
        reason: "ledger",
        vault: PUBLIC,
        network: "mainnet",
      });
    }
  });
  it("serves the ledger file (probarion-<vault>-ledger.jsonl) with the same rules: anon for a public vault, the tenant ledger for a member", async () => {
    const pub = deps(null);
    const r = await loadLedger(pub.d, PUBLIC);
    expect(r).toMatchObject({
      status: "ok",
      vault: PUBLIC,
      network: "mainnet",
      audience: "public",
    });
    if (r.status === "ok") expect(r.entries).toHaveLength(1);
    expect(pub.publicCalls).toEqual(["public_vault", "public_ledger"]);
    expect(pub.serviceCalls).toEqual([]);

    expect((await loadLedger(deps(null).d, PRIVATE)).status).toBe("not_found");
    expect((await loadLedger(deps("mallory.near").d, PRIVATE)).status).toBe("not_found");
    const member = await loadLedger(deps("s.near").d, PRIVATE);
    expect(member).toMatchObject({ status: "ok", audience: "member" });
    if (member.status === "ok") expect(member.entries[0]?.body.vault).toBe(PRIVATE);
    expect((await loadLedger(deps("s.near", { network: "testnet" }).d, PRIVATE)).status).toBe(
      "not_found",
    );
  });
});

describe("publicDemoTarget (/proof with no vault)", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    await seedTenant(pg, {
      vault: PUBLIC,
      owner: "probarion.near",
      kind: "team",
      proofPublic: true,
    });
    await seedTenant(pg, { vault: PRIVATE, owner: "s.near", proofPublic: false });
  });
  afterAll(async () => {
    await pg.close();
  });

  it("sends the visitor to the demo vault only when its proof page is public on this network", async () => {
    const anon = pgliteDb(pg, "anon");
    expect(await publicDemoTarget({ publicDb: anon, network: "mainnet" }, PUBLIC)).toBe(
      `/proof/${PUBLIC}`,
    );
    expect(await publicDemoTarget({ publicDb: anon, network: "testnet" }, PUBLIC)).toBeNull();
    expect(await publicDemoTarget({ publicDb: anon, network: "mainnet" }, PRIVATE)).toBeNull();
    expect(
      await publicDemoTarget(
        { publicDb: anon, network: "mainnet" },
        "nobody.vaults.probarion.near",
      ),
    ).toBeNull();
    expect(await publicDemoTarget({ publicDb: anon, network: "mainnet" }, null)).toBeNull();
  });

  it("asks the database nothing for a missing or invalid demo vault", async () => {
    const calls: string[] = [];
    const db = counted(pgliteDb(pg, "anon"), calls);
    for (const demo of [null, "", "../etc", "Not A Vault"]) {
      expect(
        await publicDemoTarget({ publicDb: db, network: "mainnet" }, demo),
        String(demo),
      ).toBeNull();
    }
    expect(calls).toEqual([]);
  });
});
