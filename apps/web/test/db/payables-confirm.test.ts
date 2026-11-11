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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { challengeMessage } from "@/lib/auth/challenge";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import {
  fullAccessKeyVerifier,
  nearApiVerifier,
  rpcLoginProvider,
  verifyLogin,
} from "@/lib/auth/verify";
import { AUTH_RECIPIENT } from "@/lib/config";
import { sealInvoice } from "@/lib/crypto/secrets";
import { deriveSubkey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { type MemberTenant, memberRole, setTenantSettings } from "@/lib/db/tenants";
import { generateKey } from "@/lib/keys/service";
import { SupabaseLedgerStore } from "@/lib/ledger/store";
import { createVaultReader, listAll } from "@/lib/near/reader";
import { CONFIRM_RECIPIENT } from "@/lib/payables/confirm-message";
import { NUMBER_DUPLICATE_RULE } from "@/lib/payables/number-duplicate";
import {
  OWNER_CONFIRMED_RULE,
  verifyOwnerConfirmedDetail,
  verifyOwnerConfirmedEntry,
} from "@/lib/payables/owner-confirmed";
import { OWNER_CONFIRMS_RULE } from "@/lib/payables/owner-confirms";
import { type PipelineDeps, PROCESS_LEASE_SECONDS, processInvoice } from "@/lib/payables/pipeline";
import { getInvoice, type InvoiceRow, insertInvoice, listInvoices } from "@/lib/payables/store";
import { CLI_ON_NPM, cli } from "@/lib/proof/cli";
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
  /** The pages' reader answers list_spends with an error: the chain's spends cannot be read. */
  spendsFail: false,
}));
vi.mock("@/lib/env", async () => {
  const { networkPart } = await import("../fixtures/networks");
  return {
    // The vault is on testnet and this is a testnet address: the default network, with the fake chain's RPC.
    getEnv: () => ({
      ...networkPart({ defaultNetwork: "testnet", testnet: { rpcUrls: [h.url] } }),
      NEARAI_API_KEY: null,
      NEARAI_MODEL: null,
    }),
  };
});
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
    getReader: () => {
      const r = reader(new Rpc({ urls: [h.url] }));
      return h.spendsFail ? { ...r, listSpends: () => Promise.reject(new Error("no node")) } : r;
    },
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
const { loadWaitingView } = await import("@/lib/payables/waiting");
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
      network: "testnet",
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
      makeTenantProbarion("testnet", o, { now: () => NOW, archivalRpc: null });
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

  it.each([
    ["throws", () => Promise.reject(new Error("database down"))],
    ["changes nothing", () => Promise.resolve({ id: "x", status: "processing", changed: false })],
  ])(
    "a held-again cycle whose outcome write %s does not say the invoice waits",
    async (_why, write) => {
      const balances = server.chain.intents.balances;
      const saved = { ...balances };
      for (const k of Object.keys(balances)) balances[k] = "0";
      try {
        const row = await upload("17.00", { po: PO_2002, payTo: SCENARIO_BASE_ADDRESS });
        const p = await prepared(row);
        const spends = server.chain.spends.length;
        const r = await confirmInvoice(
          {
            ...deps,
            db: {
              rpc: ((fn: string, q: Record<string, unknown>) =>
                fn === "invoice_set_outcome" ? write() : h.db.rpc(fn, q)) as Db["rpc"],
            },
          },
          { member, account: OWNER, invoiceId: row.id, nonce: p.nonce, signed: sign(p) },
        );
        expect(r).toMatchObject({ ok: false, reason: "failed_unknown" });
        if (r.ok) throw new Error("not refused");
        expect(r.text).toMatch(/outcome is unknown/);
        expect(r.text).not.toMatch(/waits for you/);
        expect(server.chain.spends).toHaveLength(spends);
      } finally {
        Object.assign(balances, saved);
      }
    },
  );

  it("a held-again cycle says once that nothing went out, and that the invoice waits", async () => {
    const balances = server.chain.intents.balances;
    const saved = { ...balances };
    for (const k of Object.keys(balances)) balances[k] = "0";
    try {
      const row = await upload("16.00", { po: PO_2002, payTo: SCENARIO_BASE_ADDRESS });
      const p = await prepared(row);
      const r = await confirmInvoice(deps, {
        member,
        account: OWNER,
        invoiceId: row.id,
        nonce: p.nonce,
        signed: sign(p),
      });
      if (!r.ok) throw new Error(JSON.stringify(r));
      expect(r.text).toBe(
        "Held by code: nothing was sent (intents.balance_low). The invoice waits for you again until that clears.",
      );
    } finally {
      Object.assign(balances, saved);
    }
  });

  it("a late signature after a sweep is told the confirmation expired", async () => {
    const row = await upload("15.00");
    const other = await upload("14.00");
    const p = await prepared(row);
    await pg.query("update invoice_confirm_nonces set expires_at = now() - interval '1 second'");
    await prepared(other); // this sweeps the tenant's expired nonces
    const r = await confirmInvoice(deps, {
      member,
      account: OWNER,
      invoiceId: row.id,
      nonce: p.nonce,
      signed: sign(p),
    });
    expect(r).toMatchObject({ ok: false, reason: "nonce_unknown" });
    if (r.ok) throw new Error("not refused");
    expect(r.text).toMatch(/has expired, start again/);
    expect(r.text).not.toMatch(/not issued/);
  });

  it("a stale attempt speaks only for itself when the row no longer waits", async () => {
    const row = await upload("13.00");
    const stale = await prepared(row);
    const live = await prepared(row);
    const paid = await confirmInvoice(deps, {
      member,
      account: OWNER,
      invoiceId: row.id,
      nonce: live.nonce,
      signed: sign(live),
    });
    expect(paid).toMatchObject({ ok: true, outcome: { status: "paid" } });
    const again = await prepareConfirmation(deps, { member, account: OWNER, invoiceId: row.id });
    const late = await confirmInvoice(deps, {
      member,
      account: OWNER,
      invoiceId: row.id,
      nonce: stale.nonce,
      signed: sign(stale),
    });
    for (const r of [again, late]) {
      if (r.ok) throw new Error("not refused");
      expect(r.text).toMatch(/this attempt sent nothing/i);
      expect(r.text).toMatch(/Reload/);
      expect(r.text).not.toMatch(/Nothing was sent/);
    }
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
    // While it waits, a corrected invoice with the same number is refused by the number rule, in the ledger.
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
    const refused = await corrected();
    expect(refused).toMatchObject({
      status: "decided",
      invoiceStatus: "decided",
      outcome: { status: "refused_by_code", code: NUMBER_DUPLICATE_RULE, spendId: null },
    });
    // The same corrected text again, while the first still waits: a duplicate at intake, as any same text is.
    const correctedId = refused.status === "decided" ? refused.invoiceId : "";
    expect(await corrected()).toMatchObject({ status: "duplicate", invoiceId: correctedId });
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
    // Rejected, the first blocks nothing: the corrected text runs again on its own row, and now waits for the owner.
    const again = await corrected();
    expect(again).toMatchObject({
      status: "decided",
      invoiceStatus: "awaiting_owner",
      invoiceId: correctedId,
    });
  });

  describe("the console", () => {
    async function signInAs(account: string) {
      h.jar.set(
        SESSION_COOKIE,
        await createSessionToken(await deriveSubkey(MASTER, "session"), account, "testnet"),
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
      const out = await html(row.id);
      expect(h.panels).toHaveLength(1);
      const seen = { suggestedAmount: "49000000", invoiceHash: row.invoice_hash, mandateId: null };
      // The reason is on the card once, and it does not promise an upload that would be refused.
      expect(h.panels[0]).toMatchObject({ canConfirm: false, whyNot: null, seen });
      expect(out.split("recorded without its mandate").length - 1).toBe(1);
      expect(out.split("the same text cannot be uploaded again").length - 1).toBe(1);
      expect(out).not.toContain("upload it again");
      expect(await actions.rejectInvoiceAction(SCENARIO_VAULT, row.id, seen)).toMatchObject({
        ok: true,
      });
      expect((await getInvoice(h.db, member.tenant_id, row.id))?.status).toBe("rejected");
    });

    it("offers no Confirm when the payee's other invoices cannot be read, says why, and keeps Reject", async () => {
      const row = await upload("51.00");
      await signInAs(OWNER);
      const db = h.db;
      h.db = {
        rpc: ((fn: string, q: Record<string, unknown>) =>
          fn === "invoice_payee_recent"
            ? Promise.reject(new Error("statement timeout"))
            : db.rpc(fn, q)) as Db["rpc"],
      };
      try {
        const out = await html(row.id);
        expect(out).toContain("could not be read from the database");
        expect(out).not.toContain("mandates could not be read");
        expect(out).not.toContain("No other invoice of this payee");
        expect(h.panels).toHaveLength(1);
        expect(h.panels[0]).toMatchObject({ canConfirm: false });
        expect(String(h.panels[0]?.whyNot)).toMatch(/other invoices/);
      } finally {
        h.db = db;
      }
    });

    it("offers no Confirm when the chain cannot be read, and names that cause", async () => {
      const row = await upload("52.00");
      const w = await loadWaitingView(
        {
          db: h.db,
          master: MASTER,
          reader: {
            getConfig: () => Promise.reject(new Error("no node")),
            listMandates: () => Promise.reject(new Error("no node")),
          },
        },
        { member, account: OWNER, row, entries: await store.all(), now: new Date() },
      );
      expect(w).toMatchObject({ canConfirm: false, canReject: true, payee: null });
      expect(w.payeeProblem).toMatch(/mandates could not be read/);
    });

    it("offers no Confirm for an invoice whose mandate is not on the vault", async () => {
      const row = await upload("53.00");
      await pg.query("update invoices set status = 'processing' where id = $1", [row.id]);
      await pg.query("update invoices set mandate_id = 99 where id = $1", [row.id]);
      await pg.query("update invoices set status = 'awaiting_owner' where id = $1", [row.id]);
      const r = await getInvoice(h.db, member.tenant_id, row.id);
      if (!r) throw new Error("no row");
      const w = await loadWaitingView(
        { db: h.db, master: MASTER, reader: createVaultReader(new RpcClient({ urls: [h.url] })) },
        { member, account: OWNER, row: r, entries: await store.all(), now: new Date() },
      );
      expect(w).toMatchObject({ canConfirm: false, canReject: true });
      expect(w.payeeProblem).toMatch(/payee could not be determined/);
    });

    it("shows neither the text nor its line when the stored file does not hash to the invoice's hash", async () => {
      const row = await upload("54.00");
      const sealed = await sealInvoice(
        MASTER,
        member.tenant_id,
        new TextEncoder().encode("Invoice INV-9\nTotal 99.00 USDC"),
      );
      await pg.query(
        "update invoices set content_ciphertext = $2, content_nonce = $3 where id = $1",
        [row.id, sealed.ciphertext, sealed.nonce],
      );
      await signInAs(OWNER);
      const out = await html(row.id);
      expect(out).toContain("does not match the hash this invoice was recorded with");
      expect(out).toContain(row.invoice_hash);
      expect(out).not.toContain("99.00");
      expect(out).not.toContain("The amount was read from line");
      expect(h.panels[0]).toMatchObject({ canConfirm: false });
      expect(String(h.panels[0]?.whyNot)).toMatch(/does not match/);
    });

    it("says what happens to the same text after Reject: it is refused, and a corrected invoice is new", async () => {
      const text = `Invoice INV-7001\nPO: PO-1001\nPay to ${SCENARIO_NEAR_PAYEE}\nTotal 55.00 USDC`;
      const send = (t: string, requestId: string) =>
        processInvoice(pipeline, {
          tenant: member,
          upload: { bytes: new TextEncoder().encode(t), mediaType: "text/plain", filename: null },
          purposeBytes: PO_1001,
          actor: OWNER,
          requestId,
        });
      const first = await send(text, "req-same-1");
      if (first.status !== "decided") throw new Error(JSON.stringify(first));
      const row = await getInvoice(h.db, member.tenant_id, first.invoiceId);
      if (!row) throw new Error("no row");
      await rejectWaitingInvoice(
        { db: h.db },
        {
          member,
          account: OWNER,
          invoiceId: row.id,
          seen: { suggestedAmount: "55000000", invoiceHash: row.invoice_hash, mandateId: 1 },
        },
      );
      expect(await send(text, "req-same-2")).toMatchObject({
        status: "duplicate",
        invoiceId: row.id,
        invoiceStatus: "rejected",
      });
      expect(await send(`${text}\nCorrected`, "req-same-3")).toMatchObject({ status: "decided" });
    });

    /** A confirmed row whose cycle was cut off before any decision, and whose abort was not written. */
    async function cutOff(total: string) {
      const row = await upload(total);
      const p = await prepared(row);
      const r = await confirmInvoice(
        {
          ...deps,
          db: {
            rpc: ((fn: string, q: Record<string, unknown>) =>
              fn === "invoice_confirm_abort"
                ? Promise.reject(new Error("database down"))
                : h.db.rpc(fn, q)) as Db["rpc"],
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
      const cut = await getInvoice(h.db, member.tenant_id, row.id);
      expect(cut).toMatchObject({ status: "processing", confirmed_by: OWNER });
      return cut as InvoiceRow;
    }

    it("does not say the ledger holds a confirmation whose cycle did not finish", async () => {
      const row = await cutOff("21.00");
      // This is why the sentence would be false: the signature reached the row, and no ledger entry.
      expect(JSON.stringify(await store.all())).not.toContain(row.confirm_signature);
      await signInAs(OWNER);
      const out = await html(row.id);
      expect(out).toMatch(
        /The owner confirmed this at [^;<]+; the cycle has not been recorded as finished, so the ledger may hold no record of it\./,
      );
      expect(out).not.toContain("the signed ledger");
      expect(out).not.toContain("Confirmed by the owner");
    });

    it("keeps the ledger sentence for a row sent and waiting on the chain", async () => {
      const row = await cutOff("22.00");
      await pg.query("update invoices set status = 'unconfirmed' where id = $1", [row.id]);
      await signInAs(OWNER);
      const out = await html(row.id);
      expect(out).toContain("Confirmed by the owner");
      expect(out).toContain("the signed ledger");
      expect(out).not.toContain("has not been recorded as finished");
    });

    it.each([
      ["bytes that are not UTF-8", new Uint8Array([0xff, 0xfe, 0x80, 0x81]), "text/plain"],
      [
        "text bytes recorded as a PDF",
        new TextEncoder().encode("Invoice INV-9\nTotal 99.00 USDC"),
        "application/pdf",
      ],
    ])(
      "offers no Confirm when the retained file cannot be re-read: %s",
      async (_why, bytes, media) => {
        const row = await upload("57.00");
        const sealed = await sealInvoice(MASTER, member.tenant_id, bytes);
        await pg.query(
          "update invoices set content_ciphertext = $2, content_nonce = $3, media_type = $4 where id = $1",
          [row.id, sealed.ciphertext, sealed.nonce, media],
        );
        await signInAs(OWNER);
        const out = await html(row.id);
        expect(out).toContain("could not be opened");
        expect(out).not.toContain("99.00");
        expect(out).not.toContain("The amount was read from line");
        // The panel is rendered only when Reject is offered.
        expect(h.panels).toHaveLength(1);
        expect(h.panels[0]).toMatchObject({ canConfirm: false });
        expect(String(h.panels[0]?.whyNot)).toMatch(/checked against its hash/);
      },
    );

    it("still offers Confirm in zero-retention, where no text is kept to check", async () => {
      await setTenantSettings(h.db, member.tenant_id, { zeroRetention: true });
      try {
        member = (await memberRole(h.db, SCENARIO_VAULT, OWNER)) as MemberTenant;
        const row = await upload("23.00");
        await signInAs(OWNER);
        const out = await html(row.id);
        expect(out).toContain("only the hashes are kept");
        expect(h.panels[0]).toMatchObject({ canConfirm: true, whyNot: null });
      } finally {
        await setTenantSettings(h.db, member.tenant_id, { zeroRetention: false });
        member = (await memberRole(h.db, SCENARIO_VAULT, OWNER)) as MemberTenant;
      }
    });

    it("keeps the invoice's text verbatim and trims only the named source line", async () => {
      const text = `Invoice INV-7100\nPO: PO-1001\nPay to ${SCENARIO_NEAR_PAYEE}\n    Note\t\tkept  as   written  \n   Total    24.00 USDC`;
      const r = await processInvoice(pipeline, {
        tenant: member,
        upload: { bytes: new TextEncoder().encode(text), mediaType: "text/plain", filename: null },
        purposeBytes: PO_1001,
        actor: OWNER,
        requestId: "req-verbatim",
      });
      if (r.status !== "decided") throw new Error(JSON.stringify(r));
      await signInAs(OWNER);
      const out = await html(r.invoiceId);
      expect(out).toContain("    Note\t\tkept  as   written  ");
      expect(out).toContain(
        'The amount was read from line 5: <code class="wrap-anywhere">Total 24.00 USDC</code>',
      );
      expect(out).toMatch(/\nTotal 24\.00 USDC<\/pre>/);
    });

    describe("a row whose cycle is not recorded, and the words around it", () => {
      // These spend for real, and a spend counts against the scenario mandate's ten uses: each test gives them back, so
      // the uploads of the tests after these still wait for the owner.
      let mandates: Record<string, unknown>[] = [];
      beforeEach(() => {
        mandates = server.chain.mandates.map((m) => ({ ...m }));
      });
      afterEach(() => {
        server.chain.mandates.forEach((m, i) => {
          Object.assign(m, mandates[i]);
        });
      });

      /** What a kill after the send leaves: the spend went out and paid, and its outcome could not be written. */
      async function sentButNotRecorded(total: string) {
        const row = await upload(total);
        const p = await prepared(row);
        const spends = server.chain.spends.length;
        const r = await confirmInvoice(
          {
            ...deps,
            db: {
              rpc: ((fn: string, q: Record<string, unknown>) =>
                fn === "invoice_set_outcome"
                  ? Promise.reject(new Error("database down"))
                  : h.db.rpc(fn, q)) as Db["rpc"],
            },
          },
          { member, account: OWNER, invoiceId: row.id, nonce: p.nonce, signed: sign(p) },
        );
        expect(r).toMatchObject({ ok: true, outcome: { status: "paid" }, recorded: false });
        expect(server.chain.spends).toHaveLength(spends + 1);
        const cut = await getInvoice(h.db, member.tenant_id, row.id);
        // The column still holds the earlier, held cycle: this is what must not be shown as the result.
        expect(cut).toMatchObject({
          status: "processing",
          confirmed_by: OWNER,
          outcome: { status: "held", spendId: null },
        });
        return cut as InvoiceRow;
      }

      const expectNotRecorded = (out: string) => {
        expect(out).toContain("Outcome unknown: do not resend");
        expect(out).toContain("Not recorded yet: do not resend.");
        expect(out).not.toContain("Contract did");
        expect(out).not.toContain("Held by code");
        expect(out).not.toContain("nothing was sent");
        expect(out).not.toContain("Paid on NEAR");
      };

      it.each([
        ["the owner", OWNER],
        ["an approver", SCENARIO_APPROVER],
      ])(
        "shows %s no stored outcome when the spend paid and its outcome was not written",
        async (_who, account) => {
          const row = await sentButNotRecorded("2.10");
          await signInAs(account);
          expectNotRecorded(await html(row.id));
        },
      );

      it("shows no stored outcome while the cycle is running, and the real one once it is written", async () => {
        const row = await upload("2.20");
        const p = await prepared(row);
        await signInAs(OWNER);
        let during = "";
        const spends = server.chain.spends.length;
        const r = await confirmInvoice(
          {
            ...deps,
            db: {
              rpc: (async (fn: string, q: Record<string, unknown>) => {
                if (fn === "invoice_set_outcome" && during === "") {
                  expect(server.chain.spends).toHaveLength(spends + 1);
                  during = await html(row.id);
                }
                return h.db.rpc(fn, q);
              }) as Db["rpc"],
            },
          },
          { member, account: OWNER, invoiceId: row.id, nonce: p.nonce, signed: sign(p) },
        );
        expect(r).toMatchObject({ ok: true, outcome: { status: "paid" }, recorded: true });
        expectNotRecorded(during);
        const after = await html(row.id);
        expect(after).toContain("Paid on NEAR");
        expect(after).toContain("Contract did");
        expect(after).not.toContain("Not recorded yet");
      });

      it("shows no stored outcome for a cycle cut off before any send", async () => {
        const spends = server.chain.spends.length;
        const row = await cutOff("24.00");
        expect(server.chain.spends).toHaveLength(spends);
        expect(row.outcome).toMatchObject({ status: "held", spendId: null });
        await signInAs(OWNER);
        expectNotRecorded(await html(row.id));
      });

      it("words a processing row by its status in the list and in the payee's other invoices", async () => {
        const row = await sentButNotRecorded("2.30");
        await signInAs(OWNER);
        const list = await listHtml();
        const from = list.slice(list.indexOf(row.ref));
        const line = from.slice(0, from.indexOf("</tr>"));
        expect(line).toContain("Outcome unknown: do not resend");
        expect(line).not.toContain("Held by code");
        const waiting = await upload("29.00");
        const w = await loadWaitingView(
          { db: h.db, master: MASTER, reader: createVaultReader(new RpcClient({ urls: [h.url] })) },
          { member, account: OWNER, row: waiting, entries: await store.all(), now: new Date() },
        );
        expect(w.payee?.rows.find((r) => r.id === row.id)?.label).toBe(
          "Outcome unknown: do not resend",
        );
      });

      it("says what is true of a row left unfinished, and names the ref to read it by", async () => {
        const row = await cutOff("27.00");
        await signInAs(OWNER);
        const ref = `by this ref: <span class="mono break-all">${row.ref}</span>`;
        const processing = await html(row.id);
        expect(processing).toContain("if it was cut off, this row stays in this state");
        expect(processing).toContain(ref);
        expect(processing).not.toMatch(/watcher|reconcil/i);
        await pg.query("update invoices set status = 'unconfirmed' where id = $1", [row.id]);
        const unconfirmed = await html(row.id);
        expect(unconfirmed).toContain("This row stays in this state");
        expect(unconfirmed).toContain(ref);
        expect(unconfirmed).not.toContain("confirmed from the chain");
      });

      it.each([
        ["the owner", OWNER],
        ["an approver", SCENARIO_APPROVER],
      ])(
        "words a held-again row's last confirmation so it is true for %s",
        async (_who, account) => {
          const balances = server.chain.intents.balances;
          const saved = { ...balances };
          for (const k of Object.keys(balances)) balances[k] = "0";
          try {
            const row = await upload("19.00", { po: PO_2002, payTo: SCENARIO_BASE_ADDRESS });
            const p = await prepared(row);
            await confirmInvoice(deps, {
              member,
              account: OWNER,
              invoiceId: row.id,
              nonce: p.nonce,
              signed: sign(p),
            });
            await signInAs(account);
            const out = await html(row.id);
            expect(out).toContain("It was last confirmed as owner.testnet at ");
            expect(out).not.toContain("You last confirmed");
          } finally {
            Object.assign(balances, saved);
          }
        },
      );

      it("mentions re-checking the signature only when the ledger holds this row's record", async () => {
        const FOOT = "custom.owner_confirmed record";
        await signInAs(OWNER);
        // No confirmation at all.
        const fresh = await upload("31.50");
        expect(await html(fresh.id)).not.toContain(FOOT);
        // Confirmed and paid: the ledger holds it.
        const paid = await upload("2.40");
        const p = await prepared(paid);
        await confirmInvoice(deps, {
          member,
          account: OWNER,
          invoiceId: paid.id,
          nonce: p.nonce,
          signed: sign(p),
        });
        expect(await html(paid.id)).toContain(FOOT);
        // Sent, its outcome not written: the decision was already in the ledger.
        const sent = await sentButNotRecorded("2.50");
        expect(JSON.stringify(await store.all())).toContain(sent.confirm_signature);
        expect(await html(sent.id)).toContain(FOOT);
        // Cut off before any decision: other rows' records do not count for this one.
        const cut = await cutOff("34.50");
        expect(JSON.stringify(await store.all())).not.toContain(cut.confirm_signature);
        expect(await html(cut.id)).not.toContain(FOOT);
      });
    });

    it("the confirmed notice follows the row's state", async () => {
      await signInAs(OWNER);
      // Paid: green.
      const paid = await upload("12.00");
      const p1 = await prepared(paid);
      expect(
        await confirmInvoice(deps, {
          member,
          account: OWNER,
          invoiceId: paid.id,
          nonce: p1.nonce,
          signed: sign(p1),
        }),
      ).toMatchObject({ ok: true, outcome: { status: "paid" } });
      expect(await html(paid.id)).toMatch(/bg-ok-bg[^"]*">Confirmed by the owner/);
      // Held on chain for the approvers: amber.
      const held = await upload("61.00");
      const p2 = await prepared(held);
      expect(
        await confirmInvoice(deps, {
          member,
          account: OWNER,
          invoiceId: held.id,
          nonce: p2.nonce,
          signed: sign(p2),
        }),
      ).toMatchObject({ ok: true, outcome: { status: "held" } });
      expect(await html(held.id)).toMatch(/bg-wait-bg[^"]*">Confirmed by the owner/);
      // Confirmed, held again, then rejected: no green, and it says what the confirmation came to.
      const balances = server.chain.intents.balances;
      const saved = { ...balances };
      for (const k of Object.keys(balances)) balances[k] = "0";
      try {
        const again = await upload("18.00", { po: PO_2002, payTo: SCENARIO_BASE_ADDRESS });
        const p3 = await prepared(again);
        await confirmInvoice(deps, {
          member,
          account: OWNER,
          invoiceId: again.id,
          nonce: p3.nonce,
          signed: sign(p3),
        });
        await rejectWaitingInvoice(
          { db: h.db },
          {
            member,
            account: OWNER,
            invoiceId: again.id,
            seen: { suggestedAmount: "18000000", invoiceHash: again.invoice_hash, mandateId: 2 },
          },
        );
        const out = await html(again.id);
        expect(out).toMatch(/bg-plan-bg[^"]*">An earlier confirmation by owner\.testnet/);
        expect(out).not.toContain("Confirmed by the owner");
      } finally {
        Object.assign(balances, saved);
      }
    });

    it("shows a held spend as the chain has it now: approved and paid, rejected or expired, and never writes", async () => {
      await signInAs(OWNER);
      const row = await upload("57.00");
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
      const spend = server.chain.spends.find((s) => s.id === r.outcome.spendId);
      if (!spend) throw new Error("no spend on the fake chain");
      const ref = (await getInvoice(h.db, member.tenant_id, row.id))?.ref ?? "";
      /** This invoice's row of the list (the list holds every other test's invoices too). */
      const listed = async () => (await listHtml()).split("<tr").find((t) => t.includes(ref)) ?? "";
      /** The invoice page's "Contract did" column, up to its decision hash. */
      const contractDid = async () =>
        (await html(row.id)).split(">Contract did</h2>")[1]?.split("decision_hash")[0] ?? "";
      const before = await state(row.id);
      try {
        // Still held on chain: as the cycle recorded it.
        expect(await listed()).toContain("Held for approval");
        expect(await contractDid()).toContain("Held for approval");
        // An approver approved it and the payout went out.
        spend.status = "paid";
        expect(await listed()).toContain("Approved and paid on NEAR");
        expect(await listed()).not.toContain("Held for approval");
        const paid = await html(row.id);
        expect(paid).toMatch(/bg-ok-bg[^"]*">Approved and paid on NEAR/);
        expect(paid).toMatch(/bg-ok-bg[^"]*">Confirmed by the owner/);
        expect(paid).toContain(
          `The vault held spend #${spend.id} for an approver. Its status above is the chain&#x27;s now.`,
        );
        expect(paid).not.toContain("Held for approval");
        // Rejected, or its hold expired: nothing was paid, and it never reads as paid.
        for (const [status, label] of [
          ["rejected", "Rejected by an approver: nothing was paid"],
          ["expired", "Hold expired: nothing was paid"],
        ] as const) {
          spend.status = status;
          expect(await listed()).toContain(label);
          const out = await html(row.id);
          expect(out).toContain(label);
          expect(out).not.toMatch(/paid on NEAR|Held for approval/i);
        }
        // The chain cannot be read: the recorded status, and the page says why.
        h.spendsFail = true;
        expect(await listed()).toContain("Held for approval");
        expect(await listHtml()).toContain(
          "The vault&#x27;s spends could not be read from the chain, so a held invoice shows the status its cycle recorded. Reload to read them again.",
        );
        expect(await html(row.id)).toContain(
          "The vault&#x27;s spends could not be read from the chain, so this is the status the cycle recorded. Reload to read them again.",
        );
        // Reading the chain changed nothing: not the row, not the ledger.
        expect(await state(row.id)).toEqual(before);
      } finally {
        h.spendsFail = false;
        spend.status = "held";
      }
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

    it("offers Reject but not Confirm to a member owner who is not the vault's on-chain owner", async () => {
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
      // The banner's verb agrees with its count.
      const waits = (await listInvoices(h.db, member.tenant_id, 50)).filter(
        (i) => i.status === "awaiting_owner",
      ).length;
      expect(out).toContain(
        `${waits} invoice${waits === 1 ? " waits" : "s wait"} for you to confirm or reject the amount.`,
      );
      expect(out).not.toMatch(/\b1 invoice wait\b/);
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
        expect(paid).toContain(cli("verify --network testnet"));
        // npx needs no set-up: only the repository command has one.
        expect(paid).toContain(
          CLI_ON_NPM
            ? "has the ledger file to download first, then run"
            : "has the ledger file and the one-time setup, then run",
        );
        // G4: while the proof page is private there is no audit link; once it is public, the link opens this
        // decision's card on it, by the spend the contract created.
        expect(paid).not.toContain("Audit link:");
        expect(paid).not.toContain(`/proof/${SCENARIO_VAULT}#`);
        await setTenantSettings(h.db, member.tenant_id, { proofPublic: true });
        const spendId = r.outcome.spendId;
        expect(spendId).toEqual(expect.any(Number));
        const audited = await html(row.id);
        expect(audited).toMatch(
          new RegExp(
            `Audit link: <a [^>]*href="/proof/${SCENARIO_VAULT.replaceAll(".", "\\.")}#spend-${spendId}"`,
          ),
        );
        expect(audited).toContain("Anyone with the link can open it.");
        // The member-only parts of the page are unchanged.
        expect(audited).toContain("Paid on NEAR");
        expect(audited).toContain("Confirmed by the owner owner.testnet");
      } finally {
        await setTenantSettings(h.db, member.tenant_id, {
          zeroRetention: false,
          proofPublic: false,
        });
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
