import type { PGlite } from "@electric-sql/pglite";
import type { AnchorView, MandateView, SpendView } from "@probarion/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseMasterKey } from "@/lib/crypto/sodium";
import { generateKey, type KeyPurpose } from "@/lib/keys/service";
import { SupabaseLedgerStore } from "@/lib/ledger/store";
import type { AccessKeyState } from "@/lib/near/reader";
import { ALLOWANCE_LOW_ALERT_YOCTO, NEAR_LOW_ALERT_YOCTO } from "@/lib/near/runway";
import { pingHeartbeat, type WatchDeps, watchAll, watchTenantById } from "@/lib/watcher/watch";
import { appendBody, testSigner } from "../fixtures/ledger";
import { quietLogs } from "../fixtures/quiet-logs";
import { fakeReader, viewAccount } from "../fixtures/reader";
import { anchor, mandateView, spend } from "../fixtures/spends";
import { asRole, freshDb, seedTenant } from "./harness";
import { at } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

const V = "acme.vaults.probarion.near";
const OWNER = "acme.near";
const MASTER = parseMasterKey(Buffer.alloc(32, 4).toString("base64"));
const NOW = new Date("2026-11-11T10:00:00Z");
const DAY_MS = 86_400_000;

const LOW = "150000000000000000000000"; // 0.15 NEAR, under the 0.2 NEAR allowance threshold
const FINE = "900000000000000000000000";

const logs = quietLogs();

const fnKey = (allowance: string | null): AccessKeyState => ({
  exists: true,
  kind: "FunctionCall",
  fullAccess: false,
  allowance,
  receiverId: V,
  methodNames: ["spend"],
});
const MISSING: AccessKeyState = {
  exists: false,
  kind: null,
  fullAccess: false,
  allowance: null,
  receiverId: null,
  methodNames: [],
};

describe("watcher", () => {
  let pg: PGlite;
  let tenant: string;
  let spends: SpendView[];
  let anchors: AnchorView[];
  let mandates: MandateView[];
  let keyStates: Map<string, AccessKeyState>;
  let account: { amount: string; storage_usage: number };
  /** The `from` of every list read, per kind and vault. */
  let reads: { kind: "spends" | "anchors" | "mandates"; vault: string; from: number }[];

  beforeEach(async () => {
    pg = await freshDb();
    tenant = await seedTenant(pg, { vault: V, owner: OWNER });
    spends = [];
    anchors = [];
    mandates = [];
    keyStates = new Map();
    account = viewAccount();
    reads = [];
  });

  const deps = (over: Partial<WatchDeps> = {}): WatchDeps => ({
    db: pgliteDb(pg),
    network: "mainnet",
    now: () => NOW,
    reader: fakeReader({
      listSpends: async (vault, from, limit) => {
        reads.push({ kind: "spends", vault, from });
        return spends.slice(from, from + limit);
      },
      listAnchors: async (vault, from, limit) => {
        reads.push({ kind: "anchors", vault, from });
        return anchors.slice(from, from + limit);
      },
      listMandates: async (vault, from, limit) => {
        reads.push({ kind: "mandates", vault, from });
        return mandates.slice(from, from + limit);
      },
      accessKey: async (_vault, pk) => keyStates.get(pk) ?? MISSING,
    }),
    viewAccount: async () => account,
    ...over,
  });

  const events = async () =>
    (
      await pg.query<{ event_key: string; kind: string }>(
        "select event_key, kind from vault_events order by id",
      )
    ).rows;
  const keys = async () => (await events()).map((e) => e.event_key);
  const cursor = async (id = tenant) =>
    at(
      (
        await pg.query<{
          watch_spend_from: string;
          watch_mandate_from: string;
          watch_anchor_from: string;
          watch_ledger_seq: number;
          watch_last_at: string | null;
        }>(
          `select watch_spend_from, watch_mandate_from, watch_anchor_from, watch_ledger_seq, watch_last_at
             from tenants where id = $1`,
          [id],
        )
      ).rows,
    );

  /** An active key of a tenant, made as the console makes it. */
  async function makeKey(purpose: KeyPurpose, tenantId = tenant) {
    const db = pgliteDb(pg);
    const key = await generateKey(db, MASTER, {
      tenantId,
      purpose,
      label: purpose,
      createdBy: OWNER,
    });
    await db.rpc("agent_key_set_status", {
      tenant_id: tenantId,
      id: key.id,
      from: "pending",
      status: "active",
    });
    return key;
  }
  const activeKey = async (purpose: KeyPurpose) => (await makeKey(purpose)).publicKey;

  describe("spends, anchors and mandates", () => {
    it("records each spend status once and keeps watching the spends that are not final", async () => {
      spends = [spend(1, "held")];
      anchors = [anchor(1)];
      expect(await watchTenantById(deps(), tenant)).toEqual({ inserted: 2 }); // spend held + anchor 1
      expect(Number((await cursor()).watch_spend_from)).toBe(0);

      spends = [spend(1, "paid"), spend(2, "pending")];
      await watchTenantById(deps(), tenant);
      expect(await keys()).toEqual(["spend:1:held", "anchor:1", "spend:1:paid", "spend:2:pending"]);
      expect(Number((await cursor()).watch_spend_from)).toBe(1);

      expect(await watchTenantById(deps(), tenant)).toEqual({ inserted: 0 }); // an idempotent re-run
      expect(await keys()).toHaveLength(4);
    });

    it("has a kind for every spend status, the ones the table's check accepts", async () => {
      const statuses = [
        "held",
        "pending",
        "paid",
        "burned",
        "failed",
        "rejected",
        "expired",
      ] as const;
      spends = statuses.map((s, i) => spend(i + 1, s));
      await watchTenantById(deps(), tenant);
      expect(await events()).toEqual(
        statuses.map((s, i) => ({ event_key: `spend:${i + 1}:${s}`, kind: `spend_${s}` })),
      );
    });

    it("stores the spend's ids, amount and what Task 21 needs to say about it", async () => {
      spends = [
        spend(7, "held", { mandate_id: 3, amount: "42000000", ref: "inv-7", memo: "net 30" }),
      ];
      await watchTenantById(deps(), tenant);
      const r = at(
        (
          await pg.query<{
            spend_id: string;
            mandate_id: string;
            amount: string;
            payload: Record<string, unknown>;
          }>("select spend_id, mandate_id, amount, payload from vault_events")
        ).rows,
      );
      expect([Number(r.spend_id), Number(r.mandate_id), r.amount]).toEqual([7, 3, "42000000"]);
      expect(r.payload).toEqual({
        destination: { type: "near", account_id: "designer.near" },
        ref: "inv-7",
        held_until_ns: "999",
        memo: "net 30",
      });
    });

    it("moves past the spends that are final, and no further than the first one that is not", async () => {
      spends = [spend(1, "paid"), spend(2, "burned"), spend(3, "held"), spend(4, "paid")];
      await watchTenantById(deps(), tenant);
      expect(Number((await cursor()).watch_spend_from)).toBe(2);
      spends = [spend(1, "paid"), spend(2, "burned"), spend(3, "paid"), spend(4, "paid")];
      await watchTenantById(deps(), tenant);
      expect(Number((await cursor()).watch_spend_from)).toBe(4);
      expect(await keys()).toEqual([
        "spend:1:paid",
        "spend:2:burned",
        "spend:3:held",
        "spend:4:paid",
        "spend:3:paid",
      ]);
    });

    it("records anchors by their seq and mandates by their id, and moves each cursor by what it read", async () => {
      anchors = [anchor(1), anchor(2)];
      mandates = [mandateView(1), mandateView(2, { label: "retainer" })];
      await watchTenantById(deps(), tenant);
      expect(await keys()).toEqual(["anchor:1", "anchor:2", "mandate:1", "mandate:2"]);
      const c = await cursor();
      expect([Number(c.watch_anchor_from), Number(c.watch_mandate_from)]).toEqual([2, 2]);
      const m = await pg.query<{ kind: string; mandate_id: string; payload: unknown }>(
        "select kind, mandate_id, payload from vault_events where event_key = 'mandate:2'",
      );
      expect(at(m.rows).kind).toBe("mandate_created");
      expect(at(m.rows).payload).toEqual({
        label: "retainer",
        payee: { type: "near", account_id: "designer.near" },
      });
      const a = await pg.query<{ anchor_seq: string; payload: unknown }>(
        "select anchor_seq, payload from vault_events where event_key = 'anchor:2'",
      );
      expect(Number(at(a.rows).anchor_seq)).toBe(2);
      expect(at(a.rows).payload).toEqual({ root: "r".repeat(64), count: 3 });

      anchors = [...anchors, anchor(3)];
      expect(await watchTenantById(deps(), tenant)).toEqual({ inserted: 1 });
      expect(reads.filter((r) => r.kind === "anchors").map((r) => r.from)).toEqual([0, 2]);
    });
  });

  describe("paging", () => {
    it("reads page after page while a page comes back full", async () => {
      spends = Array.from({ length: 250 }, (_, i) => spend(i + 1, "paid"));
      mandates = Array.from({ length: 120 }, (_, i) => mandateView(i + 1));
      anchors = Array.from({ length: 100 }, (_, i) => anchor(i + 1));
      expect(await watchTenantById(deps(), tenant)).toEqual({ inserted: 470 });
      const from = (kind: string) => reads.filter((r) => r.kind === kind).map((r) => r.from);
      expect(from("spends")).toEqual([0, 100, 200]);
      expect(from("mandates")).toEqual([0, 100]);
      expect(from("anchors")).toEqual([0, 100]); // exactly one full page: the next one is empty
      const c = await cursor();
      expect([c.watch_spend_from, c.watch_mandate_from, c.watch_anchor_from].map(Number)).toEqual([
        250, 120, 100,
      ]);
    });

    it("reads at most ten pages of a kind in one run, and carries on from there in the next", async () => {
      spends = Array.from({ length: 1150 }, (_, i) => spend(i + 1, "paid"));
      expect((await watchTenantById(deps(), tenant)).inserted).toBe(1000);
      expect(reads.filter((r) => r.kind === "spends").map((r) => r.from)).toEqual(
        Array.from({ length: 10 }, (_, i) => i * 100),
      );
      expect(Number((await cursor()).watch_spend_from)).toBe(1000);

      reads = [];
      expect((await watchTenantById(deps(), tenant)).inserted).toBe(150);
      expect(reads.filter((r) => r.kind === "spends").map((r) => r.from)).toEqual([1000, 1100]);
      expect(Number((await cursor()).watch_spend_from)).toBe(1150);
      expect(await watchTenantById(deps(), tenant)).toEqual({ inserted: 0 });
    });

    it("keeps the first spend that is not final as the cursor across the pages it read", async () => {
      spends = Array.from({ length: 230 }, (_, i) => spend(i + 1, i === 150 ? "held" : "paid"));
      await watchTenantById(deps(), tenant);
      expect(Number((await cursor()).watch_spend_from)).toBe(150);
      reads = [];
      await watchTenantById(deps(), tenant);
      expect(reads.filter((r) => r.kind === "spends").map((r) => r.from)).toEqual([150]);
    });

    it("refuses a node that ignores from_index, and moves nothing", async () => {
      const page = Array.from({ length: 100 }, (_, i) => spend(i + 1, "paid"));
      const stuck = deps({
        reader: fakeReader({
          listSpends: async () => page,
          accessKey: async () => MISSING,
        }),
      });
      await expect(watchTenantById(stuck, tenant)).rejects.toThrow(/repeats/);
      expect(await events()).toEqual([]);
      expect(Number((await cursor()).watch_spend_from)).toBe(0);
    });

    it("reads the ledger 500 entries a run and continues from its cursor", async () => {
      await pg.query(
        `insert into public.ledger_entries (tenant_id, seq, kind, body, body_hash, sig, signer, link, request_id)
         select $1, g, 'payment',
                jsonb_build_object('v', 1, 'vault', $2::text, 'kind', 'payment', 'request_id', 'r' || g,
                                   'contract', jsonb_build_object('code', 'NoMandate', 'tx_hash', 'TX' || g, 'status', 'refused')),
                lpad(to_hex(g), 64, '0'), 'sig', 'ed25519:x', lpad(to_hex(g + 100000), 64, '0'), 'r' || g
           from generate_series(0, 599) g`,
        [tenant, V],
      );
      expect((await watchTenantById(deps(), tenant)).inserted).toBe(500);
      expect((await cursor()).watch_ledger_seq).toBe(500);
      expect((await watchTenantById(deps(), tenant)).inserted).toBe(100);
      expect((await cursor()).watch_ledger_seq).toBe(600);
      expect(await watchTenantById(deps(), tenant)).toEqual({ inserted: 0 });
    });
  });

  describe("refusals by the contract", () => {
    const contract = (status: string | null, code: string | null, tx_hash: string | null) => ({
      code,
      tx_hash,
      spend_id: null,
      status,
    });

    it("turns refused-by-contract ledger outcomes into events and advances the ledger cursor", async () => {
      const store = new SupabaseLedgerStore(pgliteDb(pg), tenant);
      const s = testSigner();
      await store.append(appendBody(V), s.sign);
      await store.append(
        appendBody(V, {
          kind: "payment",
          verdict: null,
          decided_by: null,
          request_id: "req-2",
          contract: contract("refused", "NoMandate", "FAILTX"),
        }),
        s.sign,
      );
      await watchTenantById(deps(), tenant);
      const r = at(
        (
          await pg.query<{
            event_key: string;
            kind: string;
            code: string;
            tx_hash: string;
            mandate_id: string;
            amount: string;
            payload: unknown;
          }>(
            "select event_key, kind, code, tx_hash, mandate_id, amount, payload from vault_events where kind = 'refused_by_contract'",
          )
        ).rows,
      );
      expect(r.event_key).toBe("refused:1");
      expect([r.code, r.tx_hash, Number(r.mandate_id), r.amount]).toEqual([
        "NoMandate",
        "FAILTX",
        1,
        "25000000",
      ]);
      expect(r.payload).toEqual({ request_id: "req-2" });
      expect((await cursor()).watch_ledger_seq).toBe(2);
    });

    it("counts a refusal as /usage does: a payment entry, refused, with a transaction", async () => {
      const store = new SupabaseLedgerStore(pgliteDb(pg), tenant);
      const s = testSigner();
      const payment = (n: number, c: ReturnType<typeof contract>, kind: "payment" | "note") =>
        store.append(
          appendBody(V, {
            kind,
            verdict: null,
            decided_by: null,
            request_id: `req-${n}`,
            contract: c,
          }),
          s.sign,
        );
      await payment(0, contract("refused", "NoMandate", "TX0"), "payment"); // seq 0: counts
      await payment(1, contract("failed", "NoMandate", "TX1"), "payment"); // a failed send is not a refusal
      await payment(2, contract("unknown", "NoMandate", "TX2"), "payment"); // nor is one whose outcome is unknown
      await payment(3, contract("refused", "NoMandate", null), "payment"); // a dry run has no transaction
      await payment(4, contract("refused", "NoMandate", ""), "payment"); // an empty hash is none
      await payment(5, contract("refused", "NoMandate", "TX5"), "note"); // not a payment entry
      await payment(6, contract("refused", "AmountTooHigh", "TX6"), "payment"); // counts
      await store.append(appendBody(V, { request_id: "req-7" }), s.sign); // a decision: no contract at all
      await watchTenantById(deps(), tenant);
      expect(await keys()).toEqual(["refused:0", "refused:6"]);
      expect((await cursor()).watch_ledger_seq).toBe(8); // moved past every entry it read
    });
  });

  describe("allowance_low", () => {
    it("raises allowance_low once per key per UTC day below 0.2 NEAR", async () => {
      const pk = await activeKey("agent");
      keyStates.set(pk, fnKey(LOW));
      await watchTenantById(deps(), tenant);
      await watchTenantById(deps(), tenant);
      const low = (await events()).filter((e) => e.kind === "allowance_low");
      expect(low.map((e) => e.event_key)).toEqual([`allowance_low:${pk}:2026-11-11`]);
      const p = await pg.query<{ payload: unknown }>(
        "select payload from vault_events where kind = 'allowance_low'",
      );
      expect(at(p.rows).payload).toEqual({ public_key: pk, purpose: "agent", allowance: LOW });

      // The next UTC day it is raised again, and a minute before midnight it is still the same day.
      await watchTenantById(deps({ now: () => new Date("2026-11-11T23:59:59Z") }), tenant);
      expect((await keys()).filter((k) => k.startsWith("allowance_low"))).toHaveLength(1);
      await watchTenantById(deps({ now: () => new Date(NOW.getTime() + DAY_MS) }), tenant);
      expect((await keys()).filter((k) => k.startsWith("allowance_low"))).toEqual([
        `allowance_low:${pk}:2026-11-11`,
        `allowance_low:${pk}:2026-11-12`,
      ]);
    });

    it("watches the ledger key too, and says which purpose it is", async () => {
      const agent = await activeKey("agent");
      const ledger = await activeKey("ledger");
      keyStates.set(agent, fnKey(FINE));
      keyStates.set(ledger, fnKey(LOW));
      await watchTenantById(deps(), tenant);
      expect(await keys()).toEqual([`allowance_low:${ledger}:2026-11-11`]);
      const p = await pg.query<{ payload: { purpose: string } }>(
        "select payload from vault_events where kind = 'allowance_low'",
      );
      expect(at(p.rows).payload.purpose).toBe("ledger");
    });

    it("stays quiet at the threshold, for an unlimited key and for a key the chain does not show", async () => {
      const exact = await activeKey("agent");
      const unlimited = await activeKey("agent");
      const gone = await activeKey("agent");
      const fine = await activeKey("agent");
      keyStates.set(exact, fnKey(ALLOWANCE_LOW_ALERT_YOCTO.toString()));
      keyStates.set(unlimited, fnKey(null));
      keyStates.set(gone, MISSING);
      keyStates.set(fine, fnKey(FINE));
      await watchTenantById(deps(), tenant);
      expect(await events()).toEqual([]);
      // One yocto under the threshold is low.
      keyStates.set(exact, fnKey((ALLOWANCE_LOW_ALERT_YOCTO - 1n).toString()));
      await watchTenantById(deps(), tenant);
      expect(await keys()).toEqual([`allowance_low:${exact}:2026-11-11`]);
    });

    it("looks at active keys only, and only at this tenant's", async () => {
      const db = pgliteDb(pg);
      await generateKey(db, MASTER, {
        tenantId: tenant,
        purpose: "agent",
        label: "pending",
        createdBy: OWNER,
      });
      const revoked = await makeKey("agent");
      await db.rpc("agent_key_set_status", {
        tenant_id: tenant,
        id: revoked.id,
        from: "active",
        status: "revoked",
      });
      const other = await seedTenant(pg, { vault: "other.vaults.probarion.near", owner: "o.near" });
      await makeKey("agent", other);
      const asked: string[] = [];
      const d = deps({
        reader: fakeReader({
          accessKey: async (vault, pk) => {
            asked.push(`${vault}:${pk}`);
            return fnKey(LOW);
          },
        }),
      });
      await watchTenantById(d, tenant);
      expect(asked).toEqual([]); // a pending key, a revoked key and another vault's key: nothing to read
      expect(await events()).toEqual([]);
    });

    it("keeps recording spends when a key's allowance cannot be read, and says so in the log", async () => {
      const pk = await activeKey("agent");
      spends = [spend(1, "held")];
      const d = deps({
        reader: fakeReader({
          listSpends: async () => spends,
          accessKey: async () => {
            throw new Error("rpc down");
          },
        }),
      });
      expect(await watchTenantById(d, tenant)).toEqual({ inserted: 1 });
      expect(await keys()).toEqual(["spend:1:held"]);
      const warned = logs.lines.filter((l) => l.includes("watch.check_failed"));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("allowance");
      expect(warned[0]).toContain("rpc down");
      expect(warned[0]).not.toContain(pk.slice(8)); // ids and counts, not the key
    });
  });

  describe("near_low", () => {
    // 0.0499 NEAR of free NEAR: 1,000 bytes of storage stake (0.01 NEAR) and a balance of 0.0599 NEAR.
    const LOW_ACCOUNT = { amount: "59900000000000000000000", storage_usage: 1000 };

    it("raises near_low once per UTC day while the free NEAR is below 0.05 NEAR", async () => {
      account = LOW_ACCOUNT;
      await watchTenantById(deps(), tenant);
      await watchTenantById(deps(), tenant);
      expect(await keys()).toEqual(["near_low:2026-11-11"]);
      const r = await pg.query<{ kind: string; payload: unknown; amount: string | null }>(
        "select kind, payload, amount from vault_events",
      );
      expect(at(r.rows).kind).toBe("near_low");
      expect(at(r.rows).payload).toEqual({ free_yocto: "49900000000000000000000" });

      await watchTenantById(deps({ now: () => new Date(NOW.getTime() + DAY_MS) }), tenant);
      expect(await keys()).toEqual(["near_low:2026-11-11", "near_low:2026-11-12"]);
    });

    it("stays quiet at the threshold and above it, and reads the vault's own account", async () => {
      const asked: string[] = [];
      const at05 = { amount: "60000000000000000000000", storage_usage: 1000 }; // exactly 0.05 NEAR free
      account = at05;
      await watchTenantById(
        deps({
          viewAccount: async (a) => {
            asked.push(a);
            return account;
          },
        }),
        tenant,
      );
      expect(await events()).toEqual([]);
      expect(asked).toEqual([V]);
      expect(NEAR_LOW_ALERT_YOCTO).toBe(50_000_000_000_000_000_000_000n);
      account = { amount: "59999999999999999999999", storage_usage: 1000 }; // one yocto under
      await watchTenantById(deps(), tenant);
      expect(await keys()).toEqual(["near_low:2026-11-11"]);
    });

    it("keeps recording spends when the vault's account cannot be read, and says so in the log", async () => {
      spends = [spend(1, "held")];
      const d = deps({
        viewAccount: async () => {
          throw new Error("rpc down");
        },
      });
      expect(await watchTenantById(d, tenant)).toEqual({ inserted: 1 });
      const warned = logs.lines.filter((l) => l.includes("watch.check_failed"));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("near_low");
    });
  });

  describe("runs", () => {
    it("skips a tenant whose watch lease is held, and survives one broken vault", async () => {
      const db = pgliteDb(pg);
      const grant = await db.rpc<{ acquired: boolean; until: string }>("tenant_lease", {
        tenant_id: tenant,
        kind: "watch",
        seconds: 60,
      });
      expect(await watchTenantById(deps(), tenant)).toEqual({ inserted: 0, skipped: "busy" });
      await db.rpc("tenant_release", { tenant_id: tenant, kind: "watch", until: grant.until });

      await seedTenant(pg, { vault: "broken.vaults.probarion.near", owner: "b.near" });
      spends = [spend(1, "held")];
      const flaky = deps({
        reader: fakeReader({
          listSpends: async (v, from) => {
            if (v.startsWith("broken")) throw new Error("rpc down");
            return spends.slice(from);
          },
          accessKey: async () => fnKey(FINE),
        }),
      });
      const r = await watchAll(flaky);
      expect(r).toMatchObject({ tenants: 2, errors: 1, skipped: 0 });
      expect(await keys()).toContain("spend:1:held");
      expect(logs.lines.some((l) => l.includes("watch.tenant_failed"))).toBe(true);
    });

    it("releases the lease when a run fails, so the next run is not locked out", async () => {
      const broken = deps({
        reader: fakeReader({
          listSpends: async () => {
            throw new Error("rpc down");
          },
        }),
      });
      await expect(watchTenantById(broken, tenant)).rejects.toThrow("rpc down");
      expect(await watchTenantById(deps(), tenant)).toEqual({ inserted: 0 });
    });

    it("counts a run's events and logs no event data", async () => {
      spends = [spend(1, "held", { memo: "SECRET-MEMO-TEXT", ref: "SECRET-REF-TEXT" })];
      const r = await watchAll(deps());
      expect(r).toEqual({ tenants: 1, inserted: 1, errors: 0, skipped: 0 });
      const text = logs.lines.join("\n");
      expect(text).not.toContain("SECRET-MEMO-TEXT");
      expect(text).not.toContain("SECRET-REF-TEXT");
    });

    it("leaves a tenant of another network alone", async () => {
      await pg.query(
        "insert into public.tenants (vault_id, network, kind, owner_account) values ('t.vaults.testnet', 'testnet', 'external', 't.testnet')",
      );
      const r = await watchAll(deps());
      expect(r.tenants).toBe(1);
      expect(reads.map((x) => x.vault)).toEqual([V, V, V]);
    });

    it("stops starting tenants once its 40 s are used, says how many it left, and starts with them next time", async () => {
      const t2 = await seedTenant(pg, { vault: "two.vaults.probarion.near", owner: "two.near" });
      const t3 = await seedTenant(pg, {
        vault: "three.vaults.probarion.near",
        owner: "three.near",
      });
      await pg.query("update tenants set created_at = '2026-01-01T00:00:00Z' where id = $1", [
        tenant,
      ]);
      await pg.query("update tenants set created_at = '2026-01-02T00:00:00Z' where id = $1", [t2]);
      await pg.query("update tenants set created_at = '2026-01-03T00:00:00Z' where id = $1", [t3]);

      let clock = NOW.getTime();
      const slow = (): WatchDeps =>
        deps({
          now: () => new Date(clock),
          reader: fakeReader({
            listSpends: async (vault) => {
              reads.push({ kind: "spends", vault, from: 0 });
              clock += 25_000; // each vault takes 25 s
              return [];
            },
          }),
        });

      const first = await watchAll(slow());
      expect(first).toEqual({ tenants: 3, inserted: 0, errors: 0, skipped: 1 });
      expect(reads.map((r) => r.vault)).toEqual([V, "two.vaults.probarion.near"]);
      expect((await cursor(t3)).watch_last_at).toBeNull();

      // The vault the run never reached goes first, then the one looked at longest ago.
      reads = [];
      clock = NOW.getTime();
      const second = await watchAll(slow());
      expect(second).toMatchObject({ tenants: 3, skipped: 1 });
      expect(reads.map((r) => r.vault)).toEqual(["three.vaults.probarion.near", V]);
      expect((await cursor(t3)).watch_last_at).not.toBeNull();
    });

    it("moves a vault that keeps failing behind the ones it kept the run from reaching", async () => {
      const bad = await seedTenant(pg, { vault: "bad.vaults.probarion.near", owner: "bad.near" });
      const next = await seedTenant(pg, {
        vault: "next.vaults.probarion.near",
        owner: "next.near",
      });
      await pg.query("update tenants set created_at = '2026-01-01T00:00:00Z' where id = $1", [bad]);
      await pg.query("update tenants set created_at = '2026-01-02T00:00:00Z' where id = $1", [
        tenant,
      ]);
      await pg.query("update tenants set created_at = '2026-01-03T00:00:00Z' where id = $1", [
        next,
      ]);
      spends = [spend(1, "held")];
      let clock = NOW.getTime();
      const d = deps({
        now: () => new Date(clock),
        reader: fakeReader({
          listSpends: async (v, from) => {
            reads.push({ kind: "spends", vault: v, from });
            if (v.startsWith("bad")) {
              clock += 45_000; // a vault that hangs for 45 s and then fails
              throw new Error("rpc down");
            }
            return spends.slice(from);
          },
          accessKey: async () => fnKey(FINE),
        }),
      });
      // It is first in line, uses the whole run, and leaves the other two for later.
      expect(await watchAll(d)).toEqual({ tenants: 3, inserted: 0, errors: 1, skipped: 2 });
      expect(reads.map((r) => r.vault)).toEqual(["bad.vaults.probarion.near"]);
      // Its cursors did not move, and it was marked as looked at.
      const c = await cursor(bad);
      expect([c.watch_spend_from, c.watch_anchor_from, c.watch_mandate_from].map(Number)).toEqual([
        0, 0, 0,
      ]);
      expect(c.watch_last_at).not.toBeNull();

      // Next run: the two it never reached go first, and the vault that failed goes last.
      reads = [];
      clock = NOW.getTime();
      expect(await watchAll(d)).toEqual({ tenants: 3, inserted: 2, errors: 1, skipped: 0 });
      expect(reads.map((r) => r.vault)).toEqual([
        V,
        "next.vaults.probarion.near",
        "bad.vaults.probarion.near",
      ]);
    });

    it("lets the whole run fail when the tenants cannot be listed", async () => {
      const down = deps({
        db: {
          rpc: async (fn) => {
            if (fn === "tenants_for_watch") throw new Error("db down");
            throw new Error("not reached");
          },
        },
      });
      await expect(watchAll(down)).rejects.toThrow("db down");
    });
  });

  describe("the heartbeat", () => {
    const beat = "https://uptime.betterstack.com/api/v1/heartbeat/abc";
    const fetchOf = (impl: () => Promise<Response>) => vi.fn(impl) as unknown as typeof fetch;

    it("pings the Better Stack heartbeat only when configured and the run was healthy", async () => {
      const f = vi.fn(async () => new Response("ok"));
      expect(await pingHeartbeat(null, true, f as unknown as typeof fetch)).toBe(false);
      expect(await pingHeartbeat("", true, f as unknown as typeof fetch)).toBe(false);
      expect(await pingHeartbeat(beat, false, f as unknown as typeof fetch)).toBe(false);
      expect(f).not.toHaveBeenCalled();
      expect(await pingHeartbeat(beat, true, f as unknown as typeof fetch)).toBe(true);
      expect(f).toHaveBeenCalledTimes(1);
      const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(beat);
      expect(init.method).toBe("GET");
      expect(init.signal).toBeInstanceOf(AbortSignal); // the 3 s timeout
    });

    it("is false, never an error, when the request fails or the answer is not a success", async () => {
      const down = fetchOf(async () => {
        throw new Error("connect ETIMEDOUT");
      });
      expect(await pingHeartbeat(beat, true, down)).toBe(false);
      const refused = fetchOf(async () => new Response("no", { status: 500 }));
      expect(await pingHeartbeat(beat, true, refused)).toBe(false);
    });
  });
});

describe("the watcher's SQL", () => {
  let pg: PGlite;
  let tenant: string;
  beforeEach(async () => {
    pg = await freshDb();
    tenant = await seedTenant(pg, { vault: V, owner: OWNER });
  });
  const db = () => pgliteDb(pg);

  const event = (key: string, over: Record<string, unknown> = {}) => ({
    tenant_id: tenant,
    event_key: key,
    kind: "anchor",
    ...over,
  });

  it("vault_event_insert writes a batch in order and ignores a key it already has", async () => {
    const first = await db().rpc("vault_event_insert", {
      events: [event("anchor:1", { anchor_seq: 1 }), event("anchor:2", { anchor_seq: 2 })],
    });
    expect(first).toEqual({ inserted: 2 });
    const second = await db().rpc("vault_event_insert", {
      events: [event("anchor:2"), event("anchor:3", { anchor_seq: 3 }), event("anchor:3")],
    });
    expect(second).toEqual({ inserted: 1 });
    const rows = await pg.query<{ event_key: string }>(
      "select event_key from vault_events order by id",
    );
    expect(rows.rows.map((r) => r.event_key)).toEqual(["anchor:1", "anchor:2", "anchor:3"]);
    expect(await db().rpc("vault_event_insert", { events: [] })).toEqual({ inserted: 0 });
  });

  it("vault_event_insert keeps the first row of a key, whatever a later one says", async () => {
    await db().rpc("vault_event_insert", {
      events: [event("near_low:2026-11-11", { kind: "near_low", payload: { free_yocto: "1" } })],
    });
    await db().rpc("vault_event_insert", {
      events: [event("near_low:2026-11-11", { kind: "near_low", payload: { free_yocto: "2" } })],
    });
    const r = await pg.query<{ payload: unknown }>("select payload from vault_events");
    expect(r.rows).toHaveLength(1);
    expect(at(r.rows).payload).toEqual({ free_yocto: "1" });
  });

  it("vault_event_insert refuses a bad batch whole: no kind of ours, a bad tenant, no list", async () => {
    await expect(
      db().rpc("vault_event_insert", {
        events: [event("anchor:1"), event("x:1", { kind: "spend_teleported" })],
      }),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db().rpc("vault_event_insert", { events: [{ ...event("anchor:1"), tenant_id: "nope" }] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(db().rpc("vault_event_insert", { events: "nope" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(db().rpc("vault_event_insert", {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    const n = await pg.query<{ n: string }>("select count(*) as n from vault_events");
    expect(Number(at(n.rows).n)).toBe(0); // the first batch was rolled back, anchor:1 included
  });

  it("tenants_for_watch lists one network's tenants with their cursors, and one tenant on request", async () => {
    await pg.query(
      "insert into public.tenants (vault_id, network, kind, owner_account) values ('t.vaults.testnet', 'testnet', 'external', 't.testnet')",
    );
    const other = await seedTenant(pg, { vault: "two.vaults.probarion.near", owner: "two.near" });
    await db().rpc("tenant_watch_cursor_set", {
      tenant_id: other,
      spend_from: 5,
      mandate_from: 6,
      anchor_from: 7,
      ledger_seq: 8,
    });
    const all = await db().rpc<Record<string, unknown>[]>("tenants_for_watch", {
      network: "mainnet",
    });
    expect(all.map((t) => t.vault_id)).toEqual([V, "two.vaults.probarion.near"]);
    expect(all[1]).toMatchObject({
      tenant_id: other,
      network: "mainnet",
      kind: "external",
      watch_spend_from: 5,
      watch_mandate_from: 6,
      watch_anchor_from: 7,
      watch_ledger_seq: 8,
    });
    const one = await db().rpc<Record<string, unknown>[]>("tenants_for_watch", {
      network: "mainnet",
      tenant_id: other,
    });
    expect(one.map((t) => t.tenant_id)).toEqual([other]);
    // The network is the caller's: a tenant of the other network is not found by its id.
    expect(await db().rpc("tenants_for_watch", { network: "testnet", tenant_id: other })).toEqual(
      [],
    );
  });

  it("tenants_for_watch refuses a network or a tenant id that is not one", async () => {
    await expect(db().rpc("tenants_for_watch", {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(db().rpc("tenants_for_watch", { network: "devnet" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      db().rpc("tenants_for_watch", { network: "mainnet", tenant_id: "nope" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("tenants_for_watch puts the tenants never watched first, then the one watched longest ago", async () => {
    const ids = [tenant];
    for (const v of ["b", "c", "d"]) {
      ids.push(await seedTenant(pg, { vault: `${v}.vaults.probarion.near`, owner: `${v}.near` }));
    }
    const [a, b, c, d] = ids as [string, string, string, string];
    // created_at: a < b < c < d. a and d were watched (d longer ago); b and c never were.
    for (const [i, id] of ids.entries()) {
      await pg.query("update tenants set created_at = $2 where id = $1", [
        id,
        `2026-01-0${i + 1}T00:00:00Z`,
      ]);
    }
    await pg.query("update tenants set watch_last_at = '2026-11-10T00:00:00Z' where id = $1", [a]);
    await pg.query("update tenants set watch_last_at = '2026-11-09T00:00:00Z' where id = $1", [d]);
    const listed = await db().rpc<{ tenant_id: string }[]>("tenants_for_watch", {
      network: "mainnet",
    });
    expect(listed.map((t) => t.tenant_id)).toEqual([b, c, d, a]);
  });

  it("tenant_watch_cursor_set sets the cursors and when the tenant was looked at", async () => {
    const r = await db().rpc("tenant_watch_cursor_set", {
      tenant_id: tenant,
      spend_from: 3,
      mandate_from: 2,
      anchor_from: 1,
      ledger_seq: 9,
    });
    expect(r).toEqual({ tenant_id: tenant });
    const row = at(
      (
        await pg.query<{
          s: string;
          m: string;
          a: string;
          l: number;
          fresh: boolean;
        }>(
          `select watch_spend_from s, watch_mandate_from m, watch_anchor_from a, watch_ledger_seq l,
                  watch_last_at > now() - interval '1 minute' as fresh from tenants where id = $1`,
          [tenant],
        )
      ).rows,
    );
    expect([Number(row.s), Number(row.m), Number(row.a), row.l, row.fresh]).toEqual([
      3,
      2,
      1,
      9,
      true,
    ]);
  });

  it("tenant_watch_cursor_set with only a tenant marks it looked at and moves no cursor", async () => {
    await db().rpc("tenant_watch_cursor_set", {
      tenant_id: tenant,
      spend_from: 3,
      mandate_from: 2,
      anchor_from: 1,
      ledger_seq: 9,
    });
    await pg.query("update tenants set watch_last_at = '2026-01-01T00:00:00Z' where id = $1", [
      tenant,
    ]);
    await db().rpc("tenant_watch_cursor_set", { tenant_id: tenant });
    const row = at(
      (
        await pg.query<{ s: string; l: number; fresh: boolean }>(
          `select watch_spend_from s, watch_ledger_seq l, watch_last_at > now() - interval '1 minute' as fresh
             from tenants where id = $1`,
          [tenant],
        )
      ).rows,
    );
    expect([Number(row.s), row.l, row.fresh]).toEqual([3, 9, true]);
  });

  it("tenant_watch_cursor_set refuses a bad tenant and a bad cursor, and answers null for a tenant that is gone", async () => {
    await expect(db().rpc("tenant_watch_cursor_set", { tenant_id: "nope" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      db().rpc("tenant_watch_cursor_set", { tenant_id: tenant, spend_from: -1 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      db().rpc("tenant_watch_cursor_set", { tenant_id: tenant, ledger_seq: "x" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(
      await db().rpc("tenant_watch_cursor_set", {
        tenant_id: "00000000-0000-4000-8000-000000000000",
      }),
    ).toBeNull();
  });

  it("only the service role can call them: anon and a signed-in member cannot", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["tenants_for_watch", { network: "mainnet" }],
      ["vault_event_insert", { events: [event("anchor:9")] }],
      ["tenant_watch_cursor_set", { tenant_id: tenant, spend_from: 1 }],
    ];
    for (const who of [pgliteDb(pg, "anon"), pgliteDb(pg, "authenticated", OWNER)]) {
      for (const [fn, args] of calls) {
        await expect(who.rpc(fn, args), fn).rejects.toThrow(/permission denied/);
      }
    }
    for (const [fn, args] of calls) {
      await expect(db().rpc(fn, args), fn).resolves.not.toBeUndefined();
    }
    const privileges = await pg.query<{ fn: string; role: string; ok: boolean }>(
      `select f as fn, r as role, has_function_privilege(r, 'public.' || f || '(jsonb)', 'execute') as ok
         from unnest(array['tenants_for_watch', 'vault_event_insert', 'tenant_watch_cursor_set']) f,
              unnest(array['anon', 'authenticated', 'service_role']) r`,
    );
    expect(privileges.rows.filter((p) => p.ok).map((p) => `${p.fn}:${p.role}`)).toEqual([
      "tenants_for_watch:service_role",
      "vault_event_insert:service_role",
      "tenant_watch_cursor_set:service_role",
    ]);
    // A member reads the events of their own vault (0001's policy) and cannot write one.
    await expect(
      asRole(pg, "authenticated", OWNER, (tx) =>
        tx.query(
          "insert into public.vault_events (tenant_id, event_key, kind) values ($1, 'x', 'anchor')",
          [tenant],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
