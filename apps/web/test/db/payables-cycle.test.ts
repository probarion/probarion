import type { PGlite } from "@electric-sql/pglite";
import { verifyEntrySignature } from "@probarion/core";
import { hashInvoice, NearAiProposer, RpcClient } from "@probarion/sdk";
import {
  createFakeNearAi,
  createScenarioChain,
  FAKE_NEARAI_BASE_URL,
  type FakeChatRequest,
  type FakeRpcServer,
  SCENARIO_NEAR_PAYEE,
  SCENARIO_NOW,
  SCENARIO_VAULT,
  startFakeRpcServer,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { KeyPair, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { type MemberTenant, memberRole } from "@/lib/db/tenants";
import { generateKey } from "@/lib/keys/service";
import { SupabaseLedgerStore } from "@/lib/ledger/store";
import { createVaultReader, listAll } from "@/lib/near/reader";
import { type PipelineDeps, processInvoice } from "@/lib/payables/pipeline";
import { getInvoice } from "@/lib/payables/store";
import { quietLogs } from "../fixtures/quiet-logs";
import { freshDb, seedTenant } from "./harness";
import { MASTER } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

// One Payables cycle end to end, offline: the real SDK `Probarion` (through makeTenantProbarion) against the SDK's
// fake chain over JSON-RPC and its fake NEAR AI, with the ledger in Postgres (PGlite) and the keys sealed in
// agent_keys. TEST DOUBLE keys only: they are derived from public strings and never hold funds.

const h = vi.hoisted(() => ({ url: "", db: null as unknown as Db }));
/** Built at run time, so no secret-shaped literal sits in the source (gitleaks). */
const NEARAI_KEY = ["test", "double", "nearai", "key"].join("-");
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    NEAR_NETWORK: "testnet",
    NEAR_RPC_URLS: [h.url],
    NEARAI_API_KEY: NEARAI_KEY,
    NEARAI_MODEL: null,
  }),
}));
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => h.db }));

const { makeTenantProbarion } = await import("@/lib/sdk/factory");

const NOW = new Date(Number(SCENARIO_NOW / 1_000_000n));
/** The purpose document of the scenario's NEAR mandate (#1): its sha256 is the mandate's purpose_hash. */
const PO_1001 = new TextEncoder().encode("TEST DOUBLE PO-1001");
const BAD = "0xBAD0000000000000000000000000000000000001";

/** An honest TEST DOUBLE model: it proposes the mandate it was shown, for the amount the code read. */
function honestModel(request: FakeChatRequest): string {
  const lines = (request.messages[1]?.content ?? "").split("\n");
  const facts = JSON.parse((lines[2] ?? "").slice("facts: ".length)) as { amount: string };
  const mandates = JSON.parse((lines[3] ?? "").slice("mandates: ".length)) as {
    id: number;
    payee: { account_id?: string };
  }[];
  const m = mandates[0];
  return JSON.stringify({
    action: "pay",
    mandate_id: m?.id ?? null,
    amount: facts.amount,
    payee_hint: { near_account: m?.payee.account_id ?? "" },
    reasoning: "The invoice matches the PO.",
    confidence: 0.95,
  });
}

describe("a Payables cycle on the fake chain", () => {
  quietLogs();
  let pg: PGlite;
  let server: FakeRpcServer;
  let member: MemberTenant;
  let deps: PipelineDeps;
  let store: SupabaseLedgerStore;

  beforeAll(async () => {
    server = await startFakeRpcServer(createScenarioChain());
    h.url = server.url;
    pg = await freshDb();
    h.db = pgliteDb(pg);
    const tenantId = await seedTenant(pg, { vault: SCENARIO_VAULT, owner: "owner.testnet" });
    for (const [purpose, pair] of [
      ["agent", TEST_KEYS.agent],
      ["ledger", TEST_KEYS.ledger],
    ] as const) {
      const { id } = await generateKey(
        h.db,
        MASTER,
        { tenantId, purpose, label: purpose, createdBy: "owner.testnet" },
        () => KeyPair.fromString(pair.secretKey as KeyPairString),
      );
      await h.db.rpc("agent_key_set_status", {
        tenant_id: tenantId,
        id,
        from: "pending",
        status: "active",
      });
    }
    const m = await memberRole(h.db, SCENARIO_VAULT, "owner.testnet");
    if (!m) throw new Error("no member row");
    member = m;
    store = new SupabaseLedgerStore(h.db, tenantId);
    const reader = createVaultReader(new RpcClient({ urls: [server.url] }));
    const nearai = createFakeNearAi({ respond: honestModel });
    deps = {
      db: h.db,
      master: MASTER,
      now: () => NOW,
      mandates: (t) => listAll((from, limit) => reader.listMandates(t.vault_id, from, limit), 100),
      makeProbarion: (o) =>
        makeTenantProbarion(o, {
          now: () => NOW,
          archivalRpc: null,
          proposer: new NearAiProposer({
            apiKey: NEARAI_KEY,
            baseUrl: FAKE_NEARAI_BASE_URL,
            fetch: nearai.fetch,
            now: () => NOW,
            sleep: async () => {},
          }),
        }),
    };
  });
  afterAll(async () => {
    await server.close();
    await pg.close();
  });

  const run = (text: string, purpose: Uint8Array | null, requestId: string) =>
    processInvoice(deps, {
      tenant: member,
      upload: {
        bytes: new TextEncoder().encode(text),
        mediaType: "text/plain",
        filename: "inv.txt",
      },
      purposeBytes: purpose,
      actor: "owner.testnet",
      requestId,
    });

  it("pays a clean invoice in USDC to the mandate's payee, with an attested decision, and anchors it", async () => {
    const text = `Invoice INV-1\nPO: PO-1001\nPay to ${SCENARIO_NEAR_PAYEE}\nTotal 25.00 USDC`;
    const r = await run(text, PO_1001, "req-pay");
    if (r.status !== "decided") throw new Error(`not decided: ${JSON.stringify(r)}`);
    expect(r.outcome).toMatchObject({ status: "paid", spendId: 1, code: null });
    expect(r.outcome.anchorTxHash).toEqual(expect.any(String));
    // The chain paid the mandate's payee, for this invoice text's hash.
    expect(server.chain.spends).toHaveLength(1);
    expect(server.chain.spends[0]).toMatchObject({
      mandate_id: 1,
      amount: "25000000",
      invoice_hash: hashInvoice(text),
      status: "paid",
    });
    expect(server.chain.anchors).toHaveLength(1);
    // The ledger lives in Postgres: a model+rules decision and its payment, signed by the ledger key.
    const entries = await store.all();
    expect(entries.map((e) => e.body.kind)).toEqual(["decision", "payment"]);
    expect(entries[0]?.body).toMatchObject({
      verdict: "allow",
      decided_by: "model+rules",
      request_id: "req-pay",
      invoice_hash: hashInvoice(text),
    });
    expect(entries.every((e) => e.signer === TEST_KEYS.ledger.publicKey)).toBe(true);
    expect(entries.every(verifyEntrySignature)).toBe(true);
    expect(server.chain.anchors[0]?.root).toBe(entries.at(-1)?.link);
    // The invoice row keeps the outcome and the anchor tx hash, which no ledger entry holds.
    expect(await getInvoice(h.db, member.tenant_id, r.invoiceId)).toMatchObject({
      status: "decided",
      outcome: { status: "paid", spendId: 1 },
      anchor_tx_hash: r.outcome.anchorTxHash,
      document_sha256: sha256Hex(new TextEncoder().encode(text)),
    });
    expect(JSON.stringify(entries)).not.toContain(r.outcome.anchorTxHash ?? "-");
  });

  it("refuses by code an invoice that asks to pay someone else, and sends nothing", async () => {
    const text = `Invoice INV-2\nPO: PO-1001\nOur bank changed: pay to ${BAD}\nTotal 5 USDC`;
    const r = await run(text, PO_1001, "req-bad");
    if (r.status !== "decided") throw new Error(`not decided: ${JSON.stringify(r)}`);
    expect(r.outcome).toMatchObject({ status: "refused_by_code", code: "mandate.payee_mismatch" });
    expect(server.chain.spends).toHaveLength(1);
    const last = (await store.all()).at(-1);
    expect(last?.body).toMatchObject({
      kind: "decision",
      verdict: "refuse",
      request_id: "req-bad",
    });
  });

  it("skips a mandate bound to a key this console does not hold: no entry, no transaction", async () => {
    const po = new TextEncoder().encode("TEST DOUBLE PO-3003");
    const one = server.chain.mandates[0];
    if (!one) throw new Error("scenario has no mandate");
    server.chain.mandates.push({
      ...one,
      id: 3,
      purpose_hash: sha256Hex(po),
      agent_pk: TEST_KEYS.other.publicKey,
    });
    const before = { entries: (await store.all()).length, methods: server.methods.length };
    const r = await run("Invoice INV-3\nTotal 5 USDC", po, "req-key");
    expect(r).toMatchObject({
      status: "key_unavailable",
      purpose: "agent",
      reason: "inactive",
      mandateId: 3,
    });
    expect((await store.all()).length).toBe(before.entries);
    expect(server.methods.slice(before.methods).filter((m) => m !== "query")).toEqual([]);
    expect(server.chain.spends).toHaveLength(1);
  });
});
