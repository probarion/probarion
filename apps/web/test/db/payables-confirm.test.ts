import type { PGlite } from "@electric-sql/pglite";
import { NETWORKS, verifyEntrySignature } from "@probarion/core";
import { RpcClient } from "@probarion/sdk";
import {
  createScenarioChain,
  type FakeRpcServer,
  SCENARIO_APPROVER,
  SCENARIO_BASE_ADDRESS,
  SCENARIO_NEAR_PAYEE,
  SCENARIO_NOW,
  SCENARIO_VAULT,
  startFakeRpcServer,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { KeyPair, type KeyPairString } from "near-api-js";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { challengeMessage } from "@/lib/auth/challenge";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import {
  fullAccessKeyVerifier,
  nearApiVerifier,
  rpcLoginProvider,
  verifyLogin,
} from "@/lib/auth/verify";
import { AUTH_RECIPIENT } from "@/lib/config";
import { deriveSubkey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { type MemberTenant, memberRole, setTenantSettings } from "@/lib/db/tenants";
import { generateKey } from "@/lib/keys/service";
import { SupabaseLedgerStore } from "@/lib/ledger/store";
import { createVaultReader, listAll } from "@/lib/near/reader";
import { CONFIRM_RECIPIENT } from "@/lib/payables/confirm-message";
import {
  OWNER_CONFIRMED_RULE,
  verifyOwnerConfirmedDetail,
  verifyOwnerConfirmedEntry,
} from "@/lib/payables/owner-confirmed";
import { OWNER_CONFIRMS_RULE } from "@/lib/payables/owner-confirms";
import { type PipelineDeps, PROCESS_LEASE_SECONDS, processInvoice } from "@/lib/payables/pipeline";
import { getInvoice, type InvoiceRow, insertInvoice, listInvoices } from "@/lib/payables/store";
import { signNep413 } from "../fixtures/nep413";
import { quietLogs } from "../fixtures/quiet-logs";
import { freshDb, seedTenant } from "./harness";
import { MASTER } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

// The owner's Confirm and Reject (rulings W-T14-R0 and R1), end to end and offline: the real SDK Probarion on the
// SDK's fake chain over JSON-RPC, the ledger and the invoices in Postgres (PGlite), NEP-413 signatures made with
// TEST DOUBLE keys (fresh key pairs, never funded) and checked against the fake chain's access keys at finality
// "final". The uploads decide rules-only (no model key), so each one waits for the owner.

const h = vi.hoisted(() => ({
  url: "",
  db: null as unknown as Db,
  jar: new Map<string, string>(),
  panels: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    NEAR_NETWORK: "testnet",
    NEAR_RPC_URLS: [h.url],
    NEARAI_API_KEY: null,
    NEARAI_MODEL: null,
  }),
}));
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => h.db }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name) } : undefined),
  }),
  headers: async () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/crypto/server", async () => {
  const sodium = await import("@/lib/crypto/sodium");
  const { MASTER: master } = await import("./keys-helpers");
  return {
    masterKey: () => master,
    subkey: (purpose: Parameters<typeof sodium.deriveSubkey>[1]) =>
      sodium.deriveSubkey(master, purpose),
  };
});
vi.mock("@/lib/near/server", async () => {
  const { RpcClient: Rpc } = await import("@probarion/sdk");
  const { createVaultReader: reader } = await import("@/lib/near/reader");
  const { NETWORKS: N } = await import("@probarion/core");
  return {
    getRpc: () => new Rpc({ urls: [h.url] }),
    getReader: () => reader(new Rpc({ urls: [h.url] })),
    chainConsts: () => N.testnet,
  };
});
vi.mock("@/components/console/ConfirmInvoicePanel", () => ({
  ConfirmInvoicePanel: (p: Record<string, unknown>) => {
    h.panels.push(p);
    return createElement("div", { "data-panel": "confirm" }, "confirm panel");
  },
}));

const { makeTenantProbarion } = await import("@/lib/sdk/factory");
const { confirmInvoice, prepareConfirmation, rejectWaitingInvoice } = await import(
  "@/lib/payables/confirm"
);
type ConfirmDeps = import("@/lib/payables/confirm").ConfirmDeps;
const actions = await import("@/app/console/[vault]/payables/actions");
const { default: InvoicePage, maxDuration: invoicePageMaxDuration } = await import(
  "@/app/console/[vault]/payables/[id]/page"
);
const { default: PayablesPage } = await import("@/app/console/[vault]/payables/page");

const NOW = new Date(Number(SCENARIO_NOW / 1_000_000n));
const OWNER = "owner.testnet";
const PO_1001 = new TextEncoder().encode("TEST DOUBLE PO-1001");
const PO_2002 = new TextEncoder().encode("TEST DOUBLE PO-2002");

describe("the owner's Confirm and Reject on the fake chain", () => {
  quietLogs();
  let pg: PGlite;
  let server: FakeRpcServer;
  let member: MemberTenant;
  let approver: MemberTenant;
  let pipeline: PipelineDeps;
  let deps: ConfirmDeps;
  let store: SupabaseLedgerStore;
  /** The owner's full-access key on the fake chain, and a function-call key of the same account. */
  const ownerKey = KeyPair.fromRandom("ed25519");
  const ownerFcKey = KeyPair.fromRandom("ed25519");
  const approverKey = KeyPair.fromString(TEST_KEYS.approver.secretKey as KeyPairString);
  let n = 0;

  beforeAll(async () => {
    server = await startFakeRpcServer(createScenarioChain());
    h.url = server.url;
    server.chain.addAccessKey(OWNER, {
      public_key: ownerKey.getPublicKey().toString(),
      permission: "FullAccess",
    });
    server.chain.addAccessKey(OWNER, {
      public_key: ownerFcKey.getPublicKey().toString(),
      permission: {
        receiver_id: SCENARIO_VAULT,
        method_names: [],
        allowance: "1000000000000000000000000",
      },
    });
    pg = await freshDb();
    h.db = pgliteDb(pg);
    const tenantId = await seedTenant(pg, {
      vault: SCENARIO_VAULT,
      owner: OWNER,
      approvers: [SCENARIO_APPROVER],
    });
    for (const [purpose, pair] of [
      ["agent", TEST_KEYS.agent],
      ["ledger", TEST_KEYS.ledger],
    ] as const) {
      const { id } = await generateKey(
        h.db,
        MASTER,
        { tenantId, purpose, label: purpose, createdBy: OWNER },
        () => KeyPair.fromString(pair.secretKey as KeyPairString),
      );
      await h.db.rpc("agent_key_set_status", {
        tenant_id: tenantId,
        id,
        from: "pending",
        status: "active",
      });
    }
    member = (await memberRole(h.db, SCENARIO_VAULT, OWNER)) as MemberTenant;
    approver = (await memberRole(h.db, SCENARIO_VAULT, SCENARIO_APPROVER)) as MemberTenant;
    store = new SupabaseLedgerStore(h.db, tenantId);
    const rpc = new RpcClient({ urls: [server.url] });
    const reader = createVaultReader(rpc);
    const probarion = (o: Parameters<PipelineDeps["makeProbarion"]>[0]) =>
      makeTenantProbarion(o, { now: () => NOW, archivalRpc: null });
    pipeline = {
      db: h.db,
      master: MASTER,
      now: () => NOW,
      mandates: (t) => listAll((from, limit) => reader.listMandates(t.vault_id, from, limit), 100),
      makeProbarion: probarion,
    };
    deps = {
      db: h.db,
      master: MASTER,
      reader,
      keyVerifier: fullAccessKeyVerifier(rpcLoginProvider(rpc)),
      network: "testnet",
      makeProbarion: probarion,
    };
  });
  afterAll(async () => {
    await server.close();
    await pg.close();
  });
  beforeEach(() => {
    h.jar.clear();
    h.panels.length = 0;
  });

  /** Uploads one invoice (rules-only: it waits for the owner) and returns its row. */
  async function upload(
    total: string,
    opts: { po?: Uint8Array; payTo?: string; number?: string; tail?: string } = {},
  ) {
    n += 1;
    const text = `Invoice ${opts.number ?? `INV-${1000 + n}`}\nPO: ${opts.po === PO_2002 ? "PO-2002" : "PO-1001"}\nPay to ${opts.payTo ?? SCENARIO_NEAR_PAYEE}\nTotal ${total} USDC${opts.tail ? `\n${opts.tail}` : ""}`;
    const r = await processInvoice(pipeline, {
      tenant: member,
      upload: {
        bytes: new TextEncoder().encode(text),
        mediaType: "text/plain",
        filename: "inv.txt",
      },
      purposeBytes: opts.po ?? PO_1001,
      actor: OWNER,
      requestId: `req-up-${n}`,
    });
    if (r.status !== "decided") throw new Error(`not decided: ${JSON.stringify(r)}`);
    return (await getInvoice(h.db, member.tenant_id, r.invoiceId)) as InvoiceRow;
  }

  async function prepared(row: InvoiceRow, account = OWNER, as = member) {
    const p = await prepareConfirmation(deps, { member: as, account, invoiceId: row.id });
    if (!p.ok) throw new Error(`not prepared: ${JSON.stringify(p)}`);
    return p;
  }

  /** What a wallet answers: the NEP-413 signature of `message` for `recipient` with `key`, as account `accountId`. */
  function sign(
    p: { message: string; nonce: string },
    key = ownerKey,
    accountId = OWNER,
    recipient = CONFIRM_RECIPIENT,
  ) {
    const s = signNep413({
      message: p.message,
      nonce: Buffer.from(p.nonce, "base64"),
      recipient,
      keyPair: key,
    });
    return { accountId, publicKey: s.publicKey, signature: s.signature };
  }

  /** The state a refused path must leave untouched. */
  async function state(id: string) {
    const row = await getInvoice(h.db, member.tenant_id, id);
    return {
      status: row?.status,
      suggested: row?.suggested_amount,
      mandate: row?.mandate_id,
      confirmedBy: row?.confirmed_by,
      outcome: row?.outcome,
      spends: server.chain.spends.length,
      entries: (await store.all()).length,
    };
  }

  it("prepares a message from database and chain values only, critical fields first", async () => {
    const row = await upload("20.00");
    expect(row).toMatchObject({
      status: "awaiting_owner",
      suggested_amount: "20000000",
      mandate_id: 1,
    });
    const p = await prepared(row);
    expect(p.recipient).toBe(CONFIRM_RECIPIENT);
    expect(p.message).toMatch(
      new RegExp(
        `^Probarion confirm v1 \\| pay 20\\.000000 USDC \\(20000000 base units\\) to near:${SCENARIO_NEAR_PAYEE} \\| vault ${SCENARIO_VAULT.replace(/\./g, "\\.")} \\(testnet\\) \\| owner ${OWNER.replace(".", "\\.")} \\| mandate 1 \\| invoice ${row.id} \\| sha256 ${row.invoice_hash} \\| nonce [0-9a-f]{64} \\| expires \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$`,
      ),
    );
    expect(Buffer.from(p.nonce, "base64")).toHaveLength(32);
    expect(p.message).toContain(`nonce ${Buffer.from(p.nonce, "base64").toString("hex")}`);
    // No string the invoice text could carry is in it: "Pay to …" and the PO reference are not.
    expect(p.message).not.toMatch(/PO-1001|INV-1/);
  });

  it("pays exactly the suggested amount once the owner signs, and records the confirmation in the signed ledger", async () => {
    const row = await upload("20.00");
    const p = await prepared(row);
    const spends = server.chain.spends.length;
    const r = await confirmInvoice(deps, {
      member,
      account: OWNER,
      invoiceId: row.id,
      nonce: p.nonce,
      signed: sign(p),
    });
    if (!r.ok) throw new Error(`not confirmed: ${JSON.stringify(r)}`);
    expect(r.invoiceStatus).toBe("decided");
    expect(r.outcome).toMatchObject({ status: "paid", code: null });
    expect(r.text).toBe("Paid on NEAR (20.000000 USDC, mandate 1)");
    expect(server.chain.spends).toHaveLength(spends + 1);
    expect(server.chain.spends.at(-1)).toMatchObject({
      mandate_id: 1,
      amount: "20000000",
      invoice_hash: row.invoice_hash,
      ref: row.ref,
      status: "paid",
    });
    const entries = await store.all();
    expect(entries.every(verifyEntrySignature)).toBe(true);
    const decision = entries.filter((e) => e.body.kind === "decision").at(-1);
    expect(decision?.body).toMatchObject({ verdict: "allow", amount: "20000000", mandate_id: 1 });
    const rule = decision?.body.rules.find((x) => x.id === OWNER_CONFIRMED_RULE);
    expect(rule?.outcome).toBe("pass");
    expect(decision?.body.rules.some((x) => x.id === OWNER_CONFIRMS_RULE)).toBe(false);
    // The ledger alone re-verifies the owner's signature, and names the final block of the key check.
    expect(verifyOwnerConfirmedDetail(rule?.detail ?? "")).toEqual({
      ok: true,
      account: OWNER,
      publicKey: ownerKey.getPublicKey().toString(),
      recordedKeyBlockHeight: server.chain.height,
    });
    expect(rule?.detail).toContain(p.message);
    // Against the decision it sits in. The SDK's clock is fixed in this test and the nonce's expiry is the database's,
    // so the entry is read at the expiry to test the amount, invoice, mandate and vault.
    if (!decision) throw new Error("no decision");
    const atExpiry = { ...decision, body: { ...decision.body, at: p.expiresAt } };
    expect(verifyOwnerConfirmedEntry(atExpiry)).toMatchObject({ ok: true, account: OWNER });
    expect(
      verifyOwnerConfirmedEntry({ ...atExpiry, body: { ...atExpiry.body, amount: "20000001" } }),
    ).toMatchObject({ ok: false });
    // The row keeps the full message, key, signature, nonce and block.
    expect(await getInvoice(h.db, member.tenant_id, row.id)).toMatchObject({
      status: "decided",
      suggested_amount: null,
      mandate_id: 1,
      confirmed_by: OWNER,
      confirm_message: p.message,
      confirm_public_key: ownerKey.getPublicKey().toString(),
      confirm_signature: sign(p).signature,
      confirm_nonce: Buffer.from(p.nonce, "base64").toString("hex"),
      confirm_key_block_height: server.chain.height,
      confirm_key_block_hash: server.chain.blockHash,
      outcome: { status: "paid" },
    });
  });

  it("a double click pays once", async () => {
    const row = await upload("21.00");
    const p1 = await prepared(row);
    const p2 = await prepared(row);
    const spends = server.chain.spends.length;
    const results = await Promise.all([
      confirmInvoice(deps, {
        member,
        account: OWNER,
        invoiceId: row.id,
        nonce: p1.nonce,
        signed: sign(p1),
      }),
      confirmInvoice(deps, {
        member,
        account: OWNER,
        invoiceId: row.id,
        nonce: p2.nonce,
        signed: sign(p2),
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^(busy|not_awaiting|nonce_used)$/),
    });
    expect(server.chain.spends).toHaveLength(spends + 1);
    // Both nonces are now spent or useless, and the row no longer waits.
    const again = await confirmInvoice(deps, {
      member,
      account: OWNER,
      invoiceId: row.id,
      nonce: p1.nonce,
      signed: sign(p1),
    });
    expect(again).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^(nonce_used|not_awaiting)$/),
    });
    expect(
      await prepareConfirmation(deps, { member, account: OWNER, invoiceId: row.id }),
    ).toMatchObject({
      ok: false,
      reason: "not_awaiting",
    });
    expect(server.chain.spends).toHaveLength(spends + 1);
  });

  it("a cycle that stops before sending anything leaves the invoice waiting, with no confirmation on it", async () => {
    const row = await upload("21.50");
    const p = await prepared(row);
    const spends = server.chain.spends.length;
    const throwing: ConfirmDeps = {
      ...deps,
      makeProbarion: () => ({
        rules: { add: () => {} },
        requestSpend: async () => {
          throw new Error("rpc down before the decision");
        },
      }),
    };
    const r = await confirmInvoice(throwing, {
      member,
      account: OWNER,
      invoiceId: row.id,
      nonce: p.nonce,
      signed: sign(p),
    });
    expect(r).toMatchObject({ ok: false, reason: "failed" });
    expect(server.chain.spends).toHaveLength(spends);
    expect(await getInvoice(h.db, member.tenant_id, row.id)).toMatchObject({
      status: "awaiting_owner",
      suggested_amount: "21500000",
      confirmed_by: null,
      confirm_signature: null,
    });
    // It can be confirmed again, with a new nonce.
    const again = await prepared(row);
    expect(
      await confirmInvoice(deps, {
        member,
        account: OWNER,
        invoiceId: row.id,
        nonce: again.nonce,
        signed: sign(again),
      }),
    ).toMatchObject({ ok: true, outcome: { status: "paid" } });
  });

  it.each([
    ["throws", () => Promise.reject(new Error("database down"))],
    ["changes nothing", () => Promise.resolve({ changed: false, status: "processing" })],
  ])(
    "when the reset %s, it says the outcome is unknown, not that the invoice waits",
    async (_why, abort) => {
      const row = await upload("21.75");
      const p = await prepared(row);
      const spends = server.chain.spends.length;
      const r = await confirmInvoice(
        {
          ...deps,
          db: {
            rpc: ((fn: string, q: Record<string, unknown>) =>
              fn === "invoice_confirm_abort" ? abort() : h.db.rpc(fn, q)) as Db["rpc"],
          },
          makeProbarion: () => ({
            rules: { add: () => {} },
            requestSpend: async () => {
              throw new Error("rpc down before the decision");
            },
          }),
        },
        { member, account: OWNER, invoiceId: row.id, nonce: p.nonce, signed: sign(p) },
      );
      expect(r).toMatchObject({ ok: false, reason: "failed_unknown" });
      if (r.ok) throw new Error("not refused");
      expect(r.text).toMatch(/outcome is unknown/);
      expect(r.text).toMatch(/processing/);
      expect(r.text).not.toMatch(/waits for you/);
      expect(server.chain.spends).toHaveLength(spends);
      expect((await getInvoice(h.db, member.tenant_id, row.id))?.status).toBe("processing");
    },
  );

  describe("every refused path changes nothing", () => {
    it("an expired confirmation", async () => {
      const row = await upload("22.00");
      const p = await prepared(row);
      await pg.query("update invoice_confirm_nonces set expires_at = now() - interval '1 second'");
      const before = await state(row.id);
      const r = await confirmInvoice(deps, {
        member,
        account: OWNER,
        invoiceId: row.id,
        nonce: p.nonce,
        signed: sign(p),
      });
      expect(r).toMatchObject({ ok: false, reason: "expired" });
      expect(r.text).toMatch(/expired/);
      expect(await state(row.id)).toEqual(before);
    });

    it("a reused nonce, and a nonce no one issued", async () => {
      const row = await upload("23.00");
      const p = await prepared(row);
      // A signature that does not verify burns the nonce: the good signature that follows is refused too.
      const wrong = sign(p, KeyPair.fromRandom("ed25519"));
      expect(
        await confirmInvoice(deps, {
          member,
          account: OWNER,
          invoiceId: row.id,
          nonce: p.nonce,
          signed: wrong,
        }),
      ).toMatchObject({ ok: false, reason: "bad_signature" });
      const before = await state(row.id);
      expect(
        await confirmInvoice(deps, {
          member,
          account: OWNER,
          invoiceId: row.id,
          nonce: p.nonce,
          signed: sign(p),
        }),
      ).toMatchObject({ ok: false, reason: "nonce_used" });
      const unknown = Buffer.alloc(32, 9).toString("base64");
      expect(
        await confirmInvoice(deps, {
          member,
          account: OWNER,
          invoiceId: row.id,
          nonce: unknown,
          signed: sign({ ...p, nonce: unknown }),
        }),
      ).toMatchObject({ ok: false, reason: "nonce_unknown" });
      expect(
        await confirmInvoice(deps, {
          member,
          account: OWNER,
          invoiceId: row.id,
          nonce: "x",
          signed: sign(p),
        }),
      ).toMatchObject({ ok: false, reason: "invalid_input" });
      expect(await state(row.id)).toEqual(before);
    });

    it("a wrong signer: a key not on the owner, the owner's function-call key, an approver, a sign-in signature", async () => {
      const row = await upload("24.00");
      const before = await state(row.id);
      const cases: [
        (
          | ReturnType<typeof sign>
          | ((p: { message: string; nonce: string }) => ReturnType<typeof sign>)
        ),
        RegExp,
      ][] = [
        [(p) => sign(p, KeyPair.fromRandom("ed25519")), /^bad_signature$/],
        [(p) => sign(p, ownerFcKey), /^bad_signature$/],
        [(p) => sign(p, approverKey, SCENARIO_APPROVER), /^not_owner$/],
        // The same nonce and message, signed for the sign-in recipient.
        [(p) => sign(p, ownerKey, OWNER, AUTH_RECIPIENT), /^bad_signature$/],
        // A sign-in challenge signed with the confirmation's nonce.
        [
          (p) =>
            sign(
              {
                message: challengeMessage(Buffer.from(p.nonce, "base64").toString("hex")),
                nonce: p.nonce,
              },
              ownerKey,
              OWNER,
              AUTH_RECIPIENT,
            ),
          /^bad_signature$/,
        ],
        [(p) => ({ ...sign(p), signature: "not base64" }), /^invalid_input$/],
      ];
      for (const [make, reason] of cases) {
        const p = await prepared(row);
        const signed = typeof make === "function" ? make(p) : make;
        const r = await confirmInvoice(deps, {
          member,
          account: OWNER,
          invoiceId: row.id,
          nonce: p.nonce,
          signed,
        });
        expect(r.ok, String(reason)).toBe(false);
        expect(r.ok ? "" : r.reason, String(reason)).toMatch(reason);
      }
      expect(await state(row.id)).toEqual(before);
    });

    it("a confirmation never verifies as a sign-in", async () => {
      const row = await upload("25.00");
      const p = await prepared(row);
      const nonce = Buffer.from(p.nonce, "base64");
      const signed = sign(p);
      // The sign-in route rebuilds its own message from its challenge nonce; even with the same nonce bytes the
      // confirmation's signature (another message, another recipient) is refused.
      expect(
        await verifyLogin(
          signed,
          { nonce, message: challengeMessage(nonce.toString("hex")) },
          nearApiVerifier(rpcLoginProvider(new RpcClient({ urls: [server.url] }))),
        ),
      ).toEqual({ ok: false, reason: "bad_signature" });
    });

    it("a session that is not the vault's owner, even with the owner's signature", async () => {
      const row = await upload("26.00");
      const before = await state(row.id);
      expect(
        await prepareConfirmation(deps, {
          member: approver,
          account: SCENARIO_APPROVER,
          invoiceId: row.id,
        }),
      ).toMatchObject({ ok: false, reason: "not_owner" });
      const p = await prepared(row);
      expect(
        await confirmInvoice(deps, {
          member: approver,
          account: SCENARIO_APPROVER,
          invoiceId: row.id,
          nonce: p.nonce,
          signed: sign(p),
        }),
      ).toMatchObject({ ok: false });
      expect(await state(row.id)).toEqual(before);
    });

    it("a row that changed after the nonce was issued, and a nonce issued for another row", async () => {
      const row = await upload("27.00");
      const other = await upload("27.50");
      const p = await prepared(row);
      const forOther = await prepared(other);
      expect(
        await confirmInvoice(deps, {
          member,
          account: OWNER,
          invoiceId: row.id,
          nonce: forOther.nonce,
          signed: sign(forOther),
        }),
      ).toMatchObject({ ok: false, reason: "nonce_mismatch" });
      // The row leaves awaiting_owner and comes back with another suggestion (a second cycle read another total).
      await pg.query("update invoices set status = 'processing' where id = $1", [row.id]);
      await pg.query("update invoices set suggested_amount = '27000001' where id = $1", [row.id]);
      await pg.query("update invoices set status = 'awaiting_owner' where id = $1", [row.id]);
      const before = await state(row.id);
      const r = await confirmInvoice(deps, {
        member,
        account: OWNER,
        invoiceId: row.id,
        nonce: p.nonce,
        signed: sign(p),
      });
      expect(r).toMatchObject({ ok: false, reason: "row_changed" });
      expect(await state(row.id)).toEqual(before);
      expect((await getInvoice(h.db, member.tenant_id, other.id))?.status).toBe("awaiting_owner");
    });

    it("a vault whose on-chain owner is no longer the session account", async () => {
      const row = await upload("29.50");
      const p = await prepared(row);
      const before = await state(row.id);
      const config = server.chain.config;
      config.owner = "new-owner.testnet";
      try {
        // The owner's key still signs as owner.testnet, but the vault now names another owner.
        expect(
          await confirmInvoice(deps, {
            member,
            account: OWNER,
            invoiceId: row.id,
            nonce: p.nonce,
            signed: sign(p),
          }),
        ).toMatchObject({ ok: false, reason: "not_owner" });
        expect(
          await prepareConfirmation(deps, { member, account: OWNER, invoiceId: row.id }),
        ).toMatchObject({
          ok: false,
          reason: "not_owner",
        });
      } finally {
        config.owner = OWNER;
      }
      expect(await state(row.id)).toEqual(before);
    });

    it("a row that no longer waits", async () => {
      const row = await upload("28.00");
      const p = await prepared(row);
      const r = await rejectWaitingInvoice(
        { db: h.db },
        {
          member,
          account: OWNER,
          invoiceId: row.id,
          seen: { suggestedAmount: "28000000", invoiceHash: row.invoice_hash, mandateId: 1 },
        },
      );
      expect(r.ok).toBe(true);
      const before = await state(row.id);
      expect(
        await confirmInvoice(deps, {
          member,
          account: OWNER,
          invoiceId: row.id,
          nonce: p.nonce,
          signed: sign(p),
        }),
      ).toMatchObject({ ok: false, reason: "not_awaiting" });
      expect(await state(row.id)).toEqual(before);
    });
  });

  it("the contract still decides: above approval_above the vault holds the spend for the approvers", async () => {
    // 60 USDC is above the mandate's approval_above (50): the upload's owner rule refused it, nothing was sent.
    const row = await upload("60.00");
    expect(row).toMatchObject({ status: "awaiting_owner", suggested_amount: "60000000" });
    const p = await prepared(row);
    const r = await confirmInvoice(deps, {
      member,
      account: OWNER,
      invoiceId: row.id,
      nonce: p.nonce,
      signed: sign(p),
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.outcome).toMatchObject({ status: "held", spendId: expect.any(Number) });
    expect(r.invoiceStatus).toBe("decided");
    expect(server.chain.spends.at(-1)).toMatchObject({ amount: "60000000", status: "held" });
  });

  it("another rule that held holds again: nothing is sent and the invoice waits for the owner again", async () => {
    const balances = server.chain.intents.balances;
    const saved = { ...balances };
    for (const k of Object.keys(balances)) balances[k] = "0";
    try {
      const row = await upload("19.00", { po: PO_2002, payTo: SCENARIO_BASE_ADDRESS });
      expect(row).toMatchObject({ status: "awaiting_owner", mandate_id: 2 });
      const p = await prepared(row);
      expect(p.message).toContain(
        `to base:${SCENARIO_BASE_ADDRESS} (asset ${NETWORKS.testnet.allowedAssets.base})`,
      );
      const spends = server.chain.spends.length;
      const r = await confirmInvoice(deps, {
        member,
        account: OWNER,
        invoiceId: row.id,
        nonce: p.nonce,
        signed: sign(p),
      });
      if (!r.ok) throw new Error(JSON.stringify(r));
      expect(r.invoiceStatus).toBe("awaiting_owner");
      expect(r.outcome).toMatchObject({
        status: "held",
        code: "intents.balance_low",
        spendId: null,
      });
      expect(server.chain.spends).toHaveLength(spends);
      expect(await getInvoice(h.db, member.tenant_id, row.id)).toMatchObject({
        status: "awaiting_owner",
        suggested_amount: "19000000",
        confirmed_by: OWNER,
      });
    } finally {
      Object.assign(balances, saved);
    }
  });

  it("confirms a zero-retention invoice: no text is needed, only what the owner signed", async () => {
    await setTenantSettings(h.db, member.tenant_id, { zeroRetention: true });
    try {
      member = (await memberRole(h.db, SCENARIO_VAULT, OWNER)) as MemberTenant;
      const row = await upload("29.00");
      expect(row).toMatchObject({ retained: false, status: "awaiting_owner" });
      const p = await prepared(row);
      const r = await confirmInvoice(deps, {
        member,
        account: OWNER,
        invoiceId: row.id,
        nonce: p.nonce,
        signed: sign(p),
      });
      expect(r).toMatchObject({ ok: true, outcome: { status: "paid" } });
    } finally {
      await setTenantSettings(h.db, member.tenant_id, { zeroRetention: false });
      member = (await memberRole(h.db, SCENARIO_VAULT, OWNER)) as MemberTenant;
    }
  });

  it("Reject ends the row with the snapshot the owner saw, and frees its keys for a corrected upload", async () => {
    const row = await upload("31.00", { number: "INV-R-77" });
    // While it waits, a corrected invoice with the same number is a duplicate.
    const corrected = () =>
      processInvoice(pipeline, {
        tenant: member,
        upload: {
          bytes: new TextEncoder().encode(
            `Invoice INV-R-77\nPO: PO-1001\nPay to ${SCENARIO_NEAR_PAYEE}\nCorrected\nTotal 30.00 USDC`,
          ),
          mediaType: "text/plain",
          filename: "inv.txt",
        },
        purposeBytes: PO_1001,
        actor: OWNER,
        requestId: `req-corrected-${Date.now()}-${Math.random()}`,
      });
    expect(await corrected()).toMatchObject({ status: "duplicate", invoiceId: row.id });
    const seen = { suggestedAmount: "31000000", invoiceHash: row.invoice_hash, mandateId: 1 };
    // An older snapshot (another amount) changes nothing.
    expect(
      await rejectWaitingInvoice(
        { db: h.db },
        {
          member,
          account: OWNER,
          invoiceId: row.id,
          seen: { ...seen, suggestedAmount: "31000001" },
        },
      ),
    ).toMatchObject({ ok: false });
    expect(
      await rejectWaitingInvoice({ db: h.db }, { member, account: OWNER, invoiceId: row.id, seen }),
    ).toMatchObject({
      ok: true,
    });
    expect(await getInvoice(h.db, member.tenant_id, row.id)).toMatchObject({
      status: "rejected",
      rejected_by: OWNER,
    });
    const again = await corrected();
    expect(again).toMatchObject({ status: "decided", invoiceStatus: "awaiting_owner" });
  });

  describe("the console", () => {
    async function signInAs(account: string) {
      h.jar.set(
        SESSION_COOKIE,
        await createSessionToken(await deriveSubkey(MASTER, "session"), account),
      );
    }
    const listHtml = async () =>
      renderToStaticMarkup(
        (await PayablesPage({
          params: Promise.resolve({ vault: SCENARIO_VAULT }),
        })) as ReactElement,
      );
    const html = async (id: string) =>
      renderToStaticMarkup(
        (await InvoicePage({
          params: Promise.resolve({ vault: SCENARIO_VAULT, id }),
        })) as ReactElement,
      );

    it("keeps the lease longer than the action that runs the payment cycle", () => {
      // Confirm runs the whole cycle in a server action of this page, under the tenant's process lease: the lease must
      // outlast the page's maxDuration with a margin, as route.test.ts checks for the upload route.
      expect(invoicePageMaxDuration + 30).toBeLessThanOrEqual(PROCESS_LEASE_SECONDS);
    });

    it("names the real total line when a due date or terms follow the total", async () => {
      const row = await upload("20.00", { tail: "Due date: 2026-11-20" });
      await signInAs(OWNER);
      const out = await html(row.id);
      expect(out).toContain(
        'The amount was read from line 4: <code class="wrap-anywhere">Total 20.00 USDC</code>',
      );
      expect(out).not.toContain('<code class="wrap-anywhere">Due date');
    });

    it("lists an older invoice of the same payee and amount past the 200 newest rows", async () => {
      const older = await upload("47.00");
      // 201 newer invoices of the vault, none under this payee's mandate.
      for (let i = 0; i < 201; i++) {
        const hash = (0x100000 + i).toString(16).padStart(64, "0");
        await insertInvoice(h.db, member.tenant_id, {
          invoiceHash: hash,
          ref: `inv-${hash.slice(-24)}`,
          filename: null,
          mediaType: "text/plain",
          documentSha256: hash,
          sealed: null,
          facts: null,
          amountIssue: null,
          fingerprint: hash.split("").reverse().join(""),
          invoiceNumberKey: null,
          requestId: "r",
          createdBy: OWNER,
        });
      }
      await pg.query("update invoices set created_at = now() - interval '1 hour' where id = $1", [
        older.id,
      ]);
      // The vault's 200 newest rows no longer hold it: a list read from them would miss it.
      const newest = await listInvoices(h.db, member.tenant_id, 500);
      expect(newest).toHaveLength(200);
      expect(newest.map((r) => r.id)).not.toContain(older.id);
      const row = await upload("47.00");
      await signInAs(OWNER);
      const out = await html(row.id);
      expect(out).toContain(older.ref);
      expect(out).toContain("same amount");
      expect(out).not.toContain("No other invoice of this payee");
      // Older than the 90 days: not listed, and the card says only what it searched.
      await pg.query("update invoices set created_at = now() - interval '91 days' where id = $1", [
        older.id,
      ]);
      expect(await html(row.id)).not.toContain(older.ref);
    });

    it("says the payee is unknown instead of an all-clear when the row's mandate is not on the vault", async () => {
      const row = await upload("48.00");
      await pg.query("update invoices set status = 'processing' where id = $1", [row.id]);
      await pg.query("update invoices set mandate_id = 99 where id = $1", [row.id]);
      await pg.query("update invoices set status = 'awaiting_owner' where id = $1", [row.id]);
      await signInAs(OWNER);
      const out = await html(row.id);
      expect(out).not.toContain("No other invoice of this payee");
      expect(out).toContain("payee could not be determined");
      expect(h.panels[0]).toMatchObject({ canConfirm: false });
    });

    it("offers Reject for a waiting row with no mandate, and Confirm says why not", async () => {
      const row = await upload("49.00");
      await pg.query("update invoices set status = 'processing' where id = $1", [row.id]);
      await pg.query("update invoices set mandate_id = null where id = $1", [row.id]);
      await pg.query("update invoices set status = 'awaiting_owner' where id = $1", [row.id]);
      await signInAs(OWNER);
      await html(row.id);
      expect(h.panels).toHaveLength(1);
      const seen = { suggestedAmount: "49000000", invoiceHash: row.invoice_hash, mandateId: null };
      expect(h.panels[0]).toMatchObject({ canConfirm: false, seen });
      expect(String(h.panels[0]?.whyNot)).toMatch(/without its mandate/);
      expect(await actions.rejectInvoiceAction(SCENARIO_VAULT, row.id, seen)).toMatchObject({
        ok: true,
      });
      expect((await getInvoice(h.db, member.tenant_id, row.id))?.status).toBe("rejected");
    });

    it("says plainly when the server could not reject", async () => {
      const row = await upload("50.00");
      await signInAs(OWNER);
      const seen = { suggestedAmount: "50000000", invoiceHash: row.invoice_hash, mandateId: 1 };
      const db = h.db;
      h.db = {
        rpc: ((fn: string, q: Record<string, unknown>) =>
          fn === "invoice_reject"
            ? Promise.reject(new Error("database down"))
            : db.rpc(fn, q)) as Db["rpc"],
      };
      try {
        const r = await actions.rejectInvoiceAction(SCENARIO_VAULT, row.id, seen);
        expect(r).toMatchObject({ ok: false, text: expect.stringMatching(/could not finish/) });
      } finally {
        h.db = db;
      }
    });

    it("refuses every Confirm and Reject action to a non-owner, and changes nothing", async () => {
      const row = await upload("32.00");
      const before = await state(row.id);
      await signInAs(SCENARIO_APPROVER);
      const seen = { suggestedAmount: "32000000", invoiceHash: row.invoice_hash, mandateId: 1 };
      expect(await actions.prepareConfirmAction(SCENARIO_VAULT, row.id)).toMatchObject({
        status: 403,
      });
      const p = await prepared(row);
      expect(
        await actions.confirmInvoiceAction(SCENARIO_VAULT, row.id, p.nonce, sign(p)),
      ).toMatchObject({ status: 403 });
      expect(await actions.rejectInvoiceAction(SCENARIO_VAULT, row.id, seen)).toMatchObject({
        status: 403,
      });
      h.jar.clear();
      expect(await actions.rejectInvoiceAction(SCENARIO_VAULT, row.id, seen)).toMatchObject({
        status: 401,
      });
      expect(await state(row.id)).toEqual(before);
      // The owner's own action prepares a confirmation, and rejects.
      await signInAs(OWNER);
      expect(await actions.prepareConfirmAction(SCENARIO_VAULT, row.id)).toMatchObject({
        ok: true,
        recipient: CONFIRM_RECIPIENT,
      });
      expect(await actions.rejectInvoiceAction(SCENARIO_VAULT, row.id, seen)).toMatchObject({
        ok: true,
      });
    });

    it("shows the owner everything before the button: amount, why, mandate, invoice line, uploader and the payee's other invoices", async () => {
      const earlier = await upload("40.00"); // same payee, equal amount
      const near = await upload("41.50"); // same payee, within 5%
      const far = await upload("55.00"); // same payee, another amount
      const other = await upload("40.00", { po: PO_2002, payTo: SCENARIO_BASE_ADDRESS }); // another payee
      const row = await upload("40.00", { number: "INV-SHOW-1" });
      await signInAs(OWNER);
      const out = await html(row.id);
      expect(out).toContain("Waiting for you");
      expect(out).toContain("40.000000 USDC");
      expect(out).toContain("40000000 base units");
      expect(out).toContain(OWNER_CONFIRMS_RULE);
      expect(out).toContain(`near:${SCENARIO_NEAR_PAYEE}`);
      // The line the amount was read from, and who uploaded the row.
      expect(out).toContain(
        'The amount was read from line 4: <code class="wrap-anywhere">Total 40.00 USDC</code>',
      );
      expect(out).toContain(`uploaded by <span class="mono break-all">${OWNER}</span>`);
      // Every invoice of this payee in the last 90 days, the equal and near amounts marked; another payee's is not.
      for (const r of [earlier, near, far]) expect(out).toContain(r.ref);
      expect(out).not.toContain(other.ref);
      expect(out).toContain("same amount");
      expect(out).toContain("within 5%");
      // The confirm panel gets the owner, and the snapshot the owner sees.
      expect(h.panels).toHaveLength(1);
      expect(h.panels[0]).toMatchObject({
        owner: OWNER,
        canConfirm: true,
        seen: { suggestedAmount: "40000000", invoiceHash: row.invoice_hash, mandateId: 1 },
      });
    });

    it("offers no button to a member owner who is not the vault's on-chain owner", async () => {
      const row = await upload("46.00");
      const config = server.chain.config;
      config.owner = "new-owner.testnet";
      try {
        await signInAs(OWNER);
        const out = await html(row.id);
        expect(out).toContain("Waiting for you");
        // Confirm is not offered; Reject still is, since it needs no chain.
        expect(h.panels).toHaveLength(1);
        expect(h.panels[0]).toMatchObject({
          canConfirm: false,
          whyNot: "You are not the vault's on-chain owner, so Confirm is not offered.",
          seen: { suggestedAmount: "46000000", invoiceHash: row.invoice_hash, mandateId: 1 },
        });
      } finally {
        config.owner = OWNER;
      }
    });

    it("shows an approver the waiting row and its reasons, but no button", async () => {
      const row = await upload("42.00");
      await signInAs(SCENARIO_APPROVER);
      const out = await html(row.id);
      expect(out).toContain("Waiting for the owner");
      expect(out).toContain("42.000000 USDC");
      expect(h.panels).toEqual([]);
      expect(out).toContain("Only the owner can confirm or reject this invoice.");
    });

    it("lists each invoice with its status in words, its amount issue and what is stored", async () => {
      const waiting = await upload("44.00");
      const unreadable = await processInvoice(pipeline, {
        tenant: member,
        upload: {
          bytes: new TextEncoder().encode(`Invoice INV-9001\nPO: PO-1001\nTotal 44.00 EUR`),
          mediaType: "text/plain",
          filename: "euro\u202Efdp.txt",
        },
        purposeBytes: PO_1001,
        actor: OWNER,
        requestId: "req-euro",
      });
      expect(unreadable).toMatchObject({ status: "decided", amountIssue: "currency" });
      await signInAs(OWNER);
      const out = await listHtml();
      expect(out).toContain(waiting.ref);
      expect(out).toContain("Waiting for you: no attested model confirmed the amount");
      expect(out).toContain("Not sent: code refused it");
      expect(out).toContain("The total is not in USD or USDC.");
      expect(out).toContain("by hand");
      // The file name is shown made safe: no right-to-left override reaches the page.
      expect(out).not.toContain("\u202E");
      expect(out).toContain("encrypted");
      // The honest model copy, and no claim that a model decides.
      expect(out).toContain(
        "Code reads the amount; an attested private model on NEAR AI Cloud must confirm it before the agent pays on its own; otherwise the invoice waits for you.",
      );
      expect(out).not.toMatch(/model[^.]{0,20} proposes, code decides/i);
      expect(out).toContain("Run the payables cycle");
      expect(out).toContain('name="zero_retention"');
    });

    it("words zero-retention as ruling R18 does, warns when the proof page is public, and lets only the owner change it", async () => {
      await setTenantSettings(h.db, member.tenant_id, { zeroRetention: true, proofPublic: true });
      try {
        await signInAs(OWNER);
        const out = await listHtml();
        expect(out).toContain(
          "the invoice file and text are not stored; the model&#x27;s answer, which may quote details, is part of the signed ledger",
        );
        expect(out).toContain(
          "Your proof page is public: the ledger, including the model&#x27;s answers",
        );
        await signInAs(SCENARIO_APPROVER);
        const theirs = await listHtml();
        expect(theirs).not.toContain('name="zero_retention"');
        expect(theirs).toContain("Only the owner can change this.");
        expect(theirs).toContain("Run the payables cycle");
        // The action itself refuses an approver, and the owner's turns it off.
        const off = new FormData();
        await actions.setZeroRetentionAction(SCENARIO_VAULT, off);
        expect((await memberRole(h.db, SCENARIO_VAULT, OWNER))?.zero_retention).toBe(true);
        await signInAs(OWNER);
        await actions.setZeroRetentionAction(SCENARIO_VAULT, off);
        expect((await memberRole(h.db, SCENARIO_VAULT, OWNER))?.zero_retention).toBe(false);
        const on = new FormData();
        on.set("zero_retention", "on");
        await actions.setZeroRetentionAction(SCENARIO_VAULT, on);
        expect((await memberRole(h.db, SCENARIO_VAULT, OWNER))?.zero_retention).toBe(true);
      } finally {
        await setTenantSettings(h.db, member.tenant_id, {
          zeroRetention: false,
          proofPublic: false,
        });
      }
    });

    it("shows a zero-retention row without a file name, and the cycle of a paid invoice with its links", async () => {
      await setTenantSettings(h.db, member.tenant_id, { zeroRetention: true });
      try {
        member = (await memberRole(h.db, SCENARIO_VAULT, OWNER)) as MemberTenant;
        const row = await upload("45.00");
        expect(row.filename).toBeNull();
        await signInAs(OWNER);
        const out = await html(row.id);
        expect(out).toContain("not stored (zero-retention)");
        expect(out).toContain("Zero-retention: only the hashes are kept.");
        expect(out).toContain("the line the amount was read from cannot be shown");
        expect(out).toContain(row.invoice_hash);
        expect(out).not.toContain("inv.txt");
        // Confirm it, then read the cycle: rules-only, the owner rule passed, the contract paid, the anchor linked.
        const p = await prepared(row);
        const r = await confirmInvoice(deps, {
          member,
          account: OWNER,
          invoiceId: row.id,
          nonce: p.nonce,
          signed: sign(p),
        });
        if (!r.ok) throw new Error(JSON.stringify(r));
        const paid = await html(row.id);
        expect(paid).toContain("Model wanted");
        expect(paid).toContain("Rules only (no model)");
        expect(paid).toContain(OWNER_CONFIRMED_RULE);
        expect(paid).toContain("Paid on NEAR");
        expect(paid).toContain("Confirmed by the owner owner.testnet");
        if (r.outcome.txHash)
          expect(paid).toContain(`https://testnet.nearblocks.io/txns/${r.outcome.txHash}`);
        const anchor = (await getInvoice(h.db, member.tenant_id, row.id))?.anchor_tx_hash;
        if (anchor) expect(paid).toContain(`https://testnet.nearblocks.io/txns/${anchor}`);
        expect(paid).toContain("node packages/cli/dist/bin.js verify --network testnet");
      } finally {
        await setTenantSettings(h.db, member.tenant_id, { zeroRetention: false });
        member = (await memberRole(h.db, SCENARIO_VAULT, OWNER)) as MemberTenant;
      }
    });

    it("is a 404 for a malformed id, another vault's id or a non-member", async () => {
      await signInAs(OWNER);
      const digest = async (id: string) => {
        try {
          await html(id);
        } catch (e) {
          return String((e as { digest?: unknown }).digest ?? e);
        }
        return "no throw";
      };
      expect(await digest("not-a-uuid")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
      expect(await digest("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(
        "NEXT_HTTP_ERROR_FALLBACK;404",
      );
      const row = await upload("43.00");
      await signInAs("mallory.testnet");
      expect(await digest(row.id)).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    });
  });
});
