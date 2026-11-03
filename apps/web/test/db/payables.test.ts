import type { PGlite } from "@electric-sql/pglite";
import type { InvoiceFacts, MandateView } from "@probarion/core";
import { hashInvoice, type SpendOutcome } from "@probarion/sdk";
import { KeyPair } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from "vitest";
import { openInvoice } from "@/lib/crypto/secrets";
import { sha256Hex } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { type MemberTenant, memberRole } from "@/lib/db/tenants";
import { generateKey } from "@/lib/keys/service";
import { refFor } from "@/lib/payables/facts";
import {
  invoiceStatusOf,
  type PipelineDeps,
  PROCESS_LEASE_SECONDS,
  type ProbarionLike,
  processInvoice,
} from "@/lib/payables/pipeline";
import { getInvoice, listInvoices } from "@/lib/payables/store";
import { tinyPdf } from "../fixtures/pdf";
import { freshDb, seedTenant } from "./harness";
import { at, expectNoSecret, LOST_MASTER, MASTER, silenceLogs } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

const NOW = new Date("2026-11-05T12:00:00Z");
/** The purpose document the owner hashed into the mandate (its sha256 is the mandate's purpose_hash). */
const PO_DOC = new TextEncoder().encode("Purchase order PO-1001, Acme design retainer");
const PURPOSE = sha256Hex(PO_DOC);
const ANCHOR_TX = "8".repeat(44);

type Outcome = SpendOutcome & {
  modelUsage: { model: string; promptTokens: number; completionTokens: number } | null;
};
const outcome = (over: Partial<SpendOutcome> = {}): Outcome => ({
  status: "paid",
  spendId: 3,
  code: null,
  txHash: "tx-paid",
  ledgerSeq: 1,
  decisionHash: "e".repeat(64),
  anchorTxHash: ANCHOR_TX,
  modelUsage: { model: "m", promptTokens: 900, completionTokens: 120 },
  ...over,
});

const text = (s: string, filename: string | null = "inv.txt") => ({
  bytes: new TextEncoder().encode(s),
  mediaType: "text/plain" as const,
  filename,
});

function mandate(id: number, agentPk: string, over: Partial<MandateView> = {}): MandateView {
  return {
    id,
    payee: { type: "near", account_id: "vendor.near" },
    purpose_hash: PURPOSE,
    max_per_payment: "100000000",
    max_total: "1000000000",
    spent: "0",
    reserved: "0",
    max_uses: 10,
    uses: 0,
    expires_at_ns: "1798761600000000000",
    approval_above: "50000000",
    agent_pk: agentPk,
    label: "design retainer",
    status: "active",
    created_at_ns: "1793750400000000000",
    ...over,
  };
}

interface Tenant {
  member: MemberTenant;
  agent: { id: string; publicKey: string; secret: string } | null;
  ledger: { id: string; publicKey: string; secret: string } | null;
}

describe("processInvoice", () => {
  const logs = silenceLogs();
  let pg: PGlite;
  let db: Db;
  let n = 0;

  beforeAll(async () => {
    pg = await freshDb();
    db = pgliteDb(pg);
  });
  afterAll(async () => {
    await pg.close();
  });

  async function activeKey(tenantId: string, purpose: "agent" | "ledger", master = MASTER) {
    const kp = KeyPair.fromRandom("ed25519");
    const { id, publicKey } = await generateKey(
      db,
      master,
      { tenantId, purpose, label: purpose, createdBy: "acme.near" },
      () => kp,
    );
    await db.rpc("agent_key_set_status", {
      tenant_id: tenantId,
      id,
      from: "pending",
      status: "active",
    });
    return { id, publicKey, secret: kp.toString() };
  }

  /** A tenant of its own per test, with both keys active unless asked otherwise. */
  async function tenant(o: { zero?: boolean; keys?: boolean } = {}): Promise<Tenant> {
    n += 1;
    const vault = `p${n}.vaults.probarion.near`;
    const id = await seedTenant(pg, { vault, owner: "acme.near" });
    if (o.zero) await pg.query("update tenants set zero_retention = true where id = $1", [id]);
    const member = await memberRole(db, vault, "acme.near");
    if (!member) throw new Error("no member row");
    if (o.keys === false) return { member, agent: null, ledger: null };
    return {
      member,
      agent: await activeKey(id, "agent"),
      ledger: await activeKey(id, "ledger"),
    };
  }

  type Deps = PipelineDeps & {
    make: Mock<PipelineDeps["makeProbarion"]>;
    process: Mock<ProbarionLike["process"]>;
  };
  function deps(
    mandates: MandateView[] | (() => Promise<MandateView[]>),
    process: ProbarionLike["process"] = async () => outcome(),
    over: Partial<PipelineDeps> = {},
  ): Deps {
    const proc = vi.fn(process);
    const make = vi.fn<PipelineDeps["makeProbarion"]>(() => ({ process: proc }));
    return {
      db,
      master: MASTER,
      mandates: typeof mandates === "function" ? mandates : async () => mandates,
      makeProbarion: make,
      now: () => NOW,
      make,
      process: proc,
      ...over,
    };
  }

  const run = (
    d: PipelineDeps,
    t: Tenant,
    body: string,
    o: Partial<{ purpose: Uint8Array | null; requestId: string; filename: string | null }> = {},
  ) =>
    processInvoice(d, {
      tenant: t.member,
      upload: text(body, o.filename === undefined ? "inv.txt" : o.filename),
      purposeBytes: o.purpose === undefined ? PO_DOC : o.purpose,
      actor: "acme.near",
      requestId: o.requestId ?? "r",
    });

  const rows = async (tenantId: string) =>
    (
      await pg.query<{
        status: string;
        retained: boolean;
        filename: string | null;
        content_ciphertext: string | null;
        content_nonce: string | null;
        facts: Record<string, unknown> | null;
        outcome: SpendOutcome | null;
        error: string | null;
        invoice_hash: string;
        document_sha256: string | null;
        anchor_tx_hash: string | null;
        model_prompt_tokens: number | null;
        request_id: string;
        ref: string;
      }>("select * from invoices where tenant_id = $1 order by created_at", [tenantId])
    ).rows;

  it("refuses to run before both keys are active", async () => {
    const t = await tenant({ keys: false });
    const d = deps([]);
    const r = await run(d, t, "Total 25 USDC");
    expect(r).toEqual({ status: "no_keys", missing: ["agent", "ledger"] });
    expect(d.make).not.toHaveBeenCalled();
    expect(await rows(t.member.tenant_id)).toEqual([]);
  });

  it("decides, stores the outcome, and encrypts the retained invoice", async () => {
    const t = await tenant();
    const body = "Invoice INV-1\nPO: PO-1001\nTotal 25 USDC";
    const d = deps([mandate(1, t.agent?.publicKey ?? "")]);
    const r = await run(d, t, body, { requestId: "req-42" });
    expect(r).toMatchObject({ status: "decided", invoiceStatus: "decided", recorded: true });
    // The payment signs with the key the mandate is bound to, and the request id travels into the SDK.
    expect(d.make).toHaveBeenCalledTimes(1);
    expect(at(d.make.mock.calls)[0]).toMatchObject({
      agentKey: t.agent?.secret,
      ledgerKey: t.ledger?.secret,
      requestId: "req-42",
    });
    // The SDK gets the text, exactly the five facts (R26), and the ref derived from the TEXT hash (ICR-3b).
    const call = at(d.process.mock.calls)[0];
    const invoiceHash = hashInvoice(body);
    expect(call).toEqual({
      text: body,
      ref: refFor(invoiceHash),
      facts: {
        invoice_hash: invoiceHash,
        amount: "25000000",
        po_ref: "PO-1001",
        purpose_hash: PURPOSE,
        payee_hint: null,
      } satisfies InvoiceFacts,
    });
    const inv = at(await rows(t.member.tenant_id));
    expect(inv).toMatchObject({
      status: "decided",
      retained: true,
      filename: "inv.txt",
      invoice_hash: invoiceHash,
      document_sha256: sha256Hex(new TextEncoder().encode(body)),
      anchor_tx_hash: ANCHOR_TX,
      model_prompt_tokens: 900,
      request_id: "req-42",
      facts: { invoice_hash: invoiceHash, amount: "25000000", invoice_number: "INV-1" },
    });
    expect(inv.outcome?.status).toBe("paid");
    expect(inv.outcome?.anchorTxHash).toBe(ANCHOR_TX);
    const clear = await openInvoice(MASTER, t.member.tenant_id, {
      ciphertext: inv.content_ciphertext ?? "",
      nonce: inv.content_nonce ?? "",
    });
    expect(new TextDecoder().decode(clear)).toContain("INV-1");
    // The lease is released.
    const lease = await pg.query<{ l: string | null }>(
      "select process_lease_until as l from tenants where id = $1",
      [t.member.tenant_id],
    );
    expect(lease.rows[0]?.l).toBeNull();
  });

  it("hashes a PDF's extracted text as the invoice, and its bytes as the document (ICR-3b)", async () => {
    const t = await tenant();
    const pdf = tinyPdf("Invoice INV-9 PO-1001 Total 12.50 USDC");
    const d = deps([mandate(1, t.agent?.publicKey ?? "")]);
    const r = await processInvoice(d, {
      tenant: t.member,
      upload: { bytes: pdf, mediaType: "application/pdf", filename: "inv-9.pdf" },
      purposeBytes: PO_DOC,
      actor: "acme.near",
      requestId: "r-pdf",
    });
    expect(r.status).toBe("decided");
    const call = at(d.process.mock.calls)[0];
    expect(call.text).toContain("INV-9");
    expect(call.facts.invoice_hash).toBe(hashInvoice(call.text));
    expect(call.facts.invoice_hash).not.toBe(sha256Hex(pdf));
    expect(call.facts).toMatchObject({ amount: "12500000", po_ref: "PO-1001" });
    expect(at(await rows(t.member.tenant_id))).toMatchObject({
      invoice_hash: hashInvoice(call.text),
      document_sha256: sha256Hex(pdf),
      ref: refFor(hashInvoice(call.text)),
    });
    // The sealed copy is the file as uploaded, not the extracted text.
    const inv = at(await rows(t.member.tenant_id));
    const clear = await openInvoice(MASTER, t.member.tenant_id, {
      ciphertext: inv.content_ciphertext ?? "",
      nonce: inv.content_nonce ?? "",
    });
    expect(sha256Hex(clear)).toBe(sha256Hex(pdf));
  });

  it("keeps only hashes in zero-retention mode, and no file name (R18)", async () => {
    const t = await tenant({ zero: true });
    const r = await run(deps([mandate(1, t.agent?.publicKey ?? "")]), t, "Total 9 USDC", {
      filename: "acme-salary-review.txt",
    });
    expect(r.status).toBe("decided");
    const inv = at(await rows(t.member.tenant_id));
    expect(inv).toMatchObject({
      retained: false,
      content_ciphertext: null,
      content_nonce: null,
      facts: null,
      filename: null,
      status: "decided",
    });
    expect(inv.invoice_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inv.document_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects a re-uploaded invoice without calling the agent again", async () => {
    const t = await tenant();
    const ms = [mandate(1, t.agent?.publicKey ?? "")];
    await run(deps(ms), t, "Invoice INV-1\nTotal 25 USDC");
    const d = deps(ms);
    const r = await run(d, t, "Invoice INV-1\nTotal 25 USDC", { requestId: "r3" });
    expect(r).toMatchObject({ status: "duplicate", invoiceStatus: "decided" });
    expect(d.make).not.toHaveBeenCalled();
    expect(await rows(t.member.tenant_id)).toHaveLength(1);
  });

  it("answers busy while another cycle holds the tenant lease (Review Focus #2)", async () => {
    const t = await tenant();
    const held = await db.rpc<{ acquired: boolean; until: string | null }>("tenant_lease", {
      tenant_id: t.member.tenant_id,
      kind: "process",
      seconds: 60,
    });
    expect(held.acquired).toBe(true);
    const d = deps([mandate(1, t.agent?.publicKey ?? "")]);
    const r = await run(d, t, "Total 1 USDC new");
    expect(r).toEqual({ status: "busy" });
    expect(d.make).not.toHaveBeenCalled();
    expect(await rows(t.member.tenant_id)).toEqual([]);
    await db.rpc("tenant_release", {
      tenant_id: t.member.tenant_id,
      kind: "process",
      until: held.until,
    });
  });

  it("holds the lease for the route's worst case while the cycle runs", async () => {
    const t = await tenant();
    let leftSeconds = -1;
    const d = deps([mandate(1, t.agent?.publicKey ?? "")], async () => {
      const r = await pg.query<{ s: number }>(
        "select extract(epoch from process_lease_until - now())::float8 as s from tenants where id = $1",
        [t.member.tenant_id],
      );
      leftSeconds = r.rows[0]?.s ?? -1;
      return outcome();
    });
    await run(d, t, "Total 4 USDC");
    expect(PROCESS_LEASE_SECONDS).toBe(90);
    expect(leftSeconds).toBeGreaterThan(PROCESS_LEASE_SECONDS - 10);
    expect(leftSeconds).toBeLessThanOrEqual(PROCESS_LEASE_SECONDS);
  });

  it("records failures, releases the lease, and runs the same invoice again on its row (R24)", async () => {
    const t = await tenant();
    const ms = [mandate(1, t.agent?.publicKey ?? "")];
    const boom = deps(ms, async () => {
      throw new Error("rpc down");
    });
    const r = await run(boom, t, "Total 2 USDC", { requestId: "r5" });
    expect(r).toMatchObject({ status: "failed", error: "rpc down" });
    const failed = at(await rows(t.member.tenant_id));
    expect(failed).toMatchObject({ status: "error", error: "rpc down", outcome: null });
    expect(logs.lines.some((l) => l.includes("payables.failed"))).toBe(true);

    const other = await run(deps(ms), t, "Total 3 USDC", { requestId: "r6" });
    expect(other.status).toBe("decided");

    const d = deps(ms);
    const again = await run(d, t, "Total 2 USDC", { requestId: "r7" });
    expect(again).toMatchObject({ status: "decided", invoiceStatus: "decided" });
    expect(d.make).toHaveBeenCalledTimes(1);
    if (r.status !== "failed" || again.status !== "decided") throw new Error("unexpected");
    expect(again.invoiceId).toBe(r.invoiceId);
    const retried = await getInvoice(db, t.member.tenant_id, r.invoiceId);
    expect(retried).toMatchObject({ status: "decided", error: null, request_id: "r7" });
    expect(await rows(t.member.tenant_id)).toHaveLength(2);
  });

  it("records an unconfirmed payment as sent, confirmation pending, and never sends it again", async () => {
    const t = await tenant();
    const ms = [mandate(1, t.agent?.publicKey ?? "")];
    const sent = outcome({
      status: "unconfirmed",
      spendId: null,
      code: "TxOutcomeUnknown",
      txHash: "TXU",
    });
    const r = await run(
      deps(ms, async () => sent),
      t,
      "Total 6 USDC",
    );
    expect(r).toMatchObject({ status: "decided", invoiceStatus: "unconfirmed", recorded: true });
    expect(at(await rows(t.member.tenant_id))).toMatchObject({
      status: "unconfirmed",
      outcome: { status: "unconfirmed", txHash: "TXU" },
    });
    const d = deps(ms);
    const again = await run(d, t, "Total 6 USDC");
    expect(again).toMatchObject({ status: "duplicate", invoiceStatus: "unconfirmed" });
    expect(d.make).not.toHaveBeenCalled();
  });

  it("treats an outcome status it does not know as unconfirmed (never as done, never re-sent)", async () => {
    expect(invoiceStatusOf({ status: "made_up" as SpendOutcome["status"] })).toBe("unconfirmed");
    expect(invoiceStatusOf({ status: "unconfirmed" })).toBe("unconfirmed");
    expect(invoiceStatusOf({ status: "refused_by_code" })).toBe("decided");
    const t = await tenant();
    const odd = outcome({ status: "made_up" as SpendOutcome["status"] });
    const r = await run(
      deps([mandate(1, t.agent?.publicKey ?? "")], async () => odd),
      t,
      "Total 7",
    );
    expect(r).toMatchObject({ status: "decided", invoiceStatus: "unconfirmed" });
    expect(at(await rows(t.member.tenant_id)).status).toBe("unconfirmed");
  });

  it("signs with the key the mandate is bound to, not with another active key", async () => {
    const t = await tenant();
    const second = await activeKey(t.member.tenant_id, "agent");
    const ms = [
      mandate(1, second.publicKey),
      mandate(2, t.agent?.publicKey ?? ""),
      mandate(3, t.agent?.publicKey ?? "", { purpose_hash: "f".repeat(64) }),
    ];
    const d = deps(ms);
    await run(d, t, "Total 8 USDC");
    expect(at(d.make.mock.calls)[0].agentKey).toBe(second.secret);
  });

  it("runs nothing when no mandate has the invoice's purpose", async () => {
    const t = await tenant();
    const d = deps([mandate(1, t.agent?.publicKey ?? "")]);
    expect(await run(d, t, "Total 5 USDC", { purpose: null })).toEqual({
      status: "no_mandate",
      purposeHash: null,
    });
    const other = new TextEncoder().encode("another PO");
    expect(await run(d, t, "Total 5 USDC", { purpose: other })).toEqual({
      status: "no_mandate",
      purposeHash: sha256Hex(other),
    });
    expect(d.make).not.toHaveBeenCalled();
    expect(await rows(t.member.tenant_id)).toEqual([]);
  });

  it("skips the cycle when the mandate's key is not active here, and never falls back to another key", async () => {
    const t = await tenant();
    const stranger = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const d = deps([mandate(4, stranger)]);
    const r = await run(d, t, "Total 5 USDC");
    expect(r).toEqual({
      status: "key_unavailable",
      purpose: "agent",
      reason: "inactive",
      mandateId: 4,
      publicKey: stranger,
    });
    expect(d.make).not.toHaveBeenCalled();
    expect(await rows(t.member.tenant_id)).toEqual([]);
    const line = logs.lines.find((l) => l.includes("payables.key_unavailable")) ?? "";
    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      tenant: t.member.tenant_id,
      vault: t.member.vault_id,
      mandate_id: 4,
      key_purpose: "agent",
      reason: "inactive",
    });
    for (const l of logs.lines) {
      expectNoSecret(l, t.agent?.secret ?? "");
      expectNoSecret(l, t.ledger?.secret ?? "");
    }
  });

  it("skips the cycle when the mandate's key cannot be opened", async () => {
    const t = await tenant();
    const sealedElsewhere = await activeKey(t.member.tenant_id, "agent", LOST_MASTER);
    const d = deps([mandate(1, sealedElsewhere.publicKey)]);
    expect(await run(d, t, "Total 5 USDC")).toMatchObject({
      status: "key_unavailable",
      purpose: "agent",
      reason: "decrypt_failed",
      mandateId: 1,
    });
    expect(d.make).not.toHaveBeenCalled();
  });

  it("skips the cycle when the ledger key cannot be opened", async () => {
    const t = await tenant();
    const d = deps([mandate(1, t.agent?.publicKey ?? "")], undefined, { master: LOST_MASTER });
    expect(await run(d, t, "Total 5 USDC")).toMatchObject({
      status: "key_unavailable",
      purpose: "ledger",
      reason: "decrypt_failed",
      mandateId: null,
    });
    expect(d.make).not.toHaveBeenCalled();
  });

  it("stores nothing when the vault's mandates cannot be read", async () => {
    const t = await tenant();
    const d = deps(async () => {
      throw new Error("every RPC endpoint failed");
    });
    expect(await run(d, t, "Total 5 USDC")).toEqual({ status: "chain_unavailable" });
    expect(d.make).not.toHaveBeenCalled();
    expect(await rows(t.member.tenant_id)).toEqual([]);
  });

  it("returns the outcome even when it cannot be written: a payment may have gone out", async () => {
    const t = await tenant();
    const flaky: Db = {
      rpc: (fn, p) =>
        fn === "invoice_set_outcome" ? Promise.reject(new Error("db down")) : db.rpc(fn, p),
    };
    const r = await run(
      deps([mandate(1, t.agent?.publicKey ?? "")], undefined, { db: flaky }),
      t,
      "Total 5 USDC",
    );
    expect(r).toMatchObject({ status: "decided", recorded: false, outcome: { status: "paid" } });
    expect(at(await rows(t.member.tenant_id)).status).toBe("processing");
    expect(logs.lines.some((l) => l.includes("payables.outcome_not_recorded"))).toBe(true);
  });

  it("answers empty for a file with no text", async () => {
    const t = await tenant();
    expect(await run(deps([]), t, "   \n ")).toEqual({ status: "empty" });
  });

  it("lists the tenant's invoices without their sealed content", async () => {
    const t = await tenant();
    await run(deps([mandate(1, t.agent?.publicKey ?? "")]), t, "Total 1 USDC");
    const list = await listInvoices(db, t.member.tenant_id);
    expect(list).toHaveLength(1);
    expect(Object.keys(at(list))).not.toContain("content_ciphertext");
    expect(Object.keys(at(list))).not.toContain("content_nonce");
    expect(at(list)).toMatchObject({
      status: "decided",
      retained: true,
      anchor_tx_hash: ANCHOR_TX,
    });
  });
});
