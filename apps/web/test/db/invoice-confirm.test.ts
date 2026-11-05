import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/port";
import {
  abortConfirmation,
  type BeginInput,
  beginConfirmation,
  burnConfirmNonce,
  getInvoice,
  insertInvoice,
  invoiceContent,
  issueConfirmNonce,
  listPayeeRecent,
  type NewInvoice,
  readConfirmNonce,
  setInvoiceOutcome,
  setInvoiceRejected,
} from "@/lib/payables/store";
import { asRole, freshDb, seedTenant } from "./harness";
import { pgliteDb } from "./pglite-db";

// The owner's way out of awaiting_owner (migration 0007, rulings W-T14-R0 and R1): a confirmation nonce issued for
// one row snapshot (id, suggested_amount, mandate_id, invoice_hash), burned in the same transaction as the
// compare-and-set that moves the row to processing and re-runs the duplicate guard; the undo when the cycle stopped
// before sending anything; Reject with the same snapshot condition (it frees the guard keys); and the service-role
// read of a retained invoice's sealed content.

const H = (c: string) => c.repeat(64);
const SEALED = { ciphertext: "Y2lwaGVy", nonce: "bm9uY2U=" };
const WAITING = {
  status: "held",
  spendId: null,
  code: "custom.owner_confirms_without_model",
  txHash: null,
  ledgerSeq: 1,
  decisionHash: H("d"),
  anchorTxHash: null,
};
const PAID = { ...WAITING, status: "paid", spendId: 1, code: null, txHash: "TX1" };
/** 64 signature bytes in standard padded base64, as the browser sends them. */
const SIG = Buffer.alloc(64, 3).toString("base64");
const PK = "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847";
const BLOCK_HASH = "4reLvkAWfqk5fsqio1KLudk46cqRz9erQdaHkWZKMJDZ";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("owner confirmation functions (migration 0007)", () => {
  let pg: PGlite;
  let db: Db;
  let a: string;
  let b: string;
  let n = 0;
  let nonces = 0;

  beforeAll(async () => {
    pg = await freshDb();
    db = pgliteDb(pg);
    a = await seedTenant(pg, { vault: "a.vaults.probarion.near", owner: "alice.near" });
    b = await seedTenant(pg, { vault: "b.vaults.probarion.near", owner: "bob.near" });
  });
  afterAll(async () => {
    await pg.close();
  });

  function invoice(over: Partial<NewInvoice> = {}): NewInvoice {
    n += 1;
    const hash = n.toString(16).padStart(64, "0");
    return {
      invoiceHash: hash,
      ref: `inv-${hash.slice(-24)}`,
      filename: "inv.txt",
      mediaType: "text/plain",
      documentSha256: H("f"),
      sealed: SEALED,
      facts: {
        invoice_hash: hash,
        amount: "1",
        po_ref: null,
        purpose_hash: null,
        payee_hint: null,
        invoice_number: null,
      },
      amountIssue: null,
      fingerprint: hash.split("").reverse().join(""),
      invoiceNumberKey: null,
      requestId: "r",
      createdBy: "alice.near",
      ...over,
    };
  }

  /** A row of tenant `t` that waits for the owner with the suggestion `amount`, under mandate `mandate`. */
  async function waiting(t = a, amount = "20000000", over: Partial<NewInvoice> = {}, mandate = 1) {
    const { id } = await insertInvoice(db, t, invoice(over));
    await setInvoiceOutcome(db, t, id, {
      status: "awaiting_owner",
      outcome: WAITING as never,
      suggestedAmount: amount,
      mandateId: mandate,
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
    return id;
  }

  const freshNonce = () => {
    nonces += 1;
    return nonces.toString(16).padStart(64, "0");
  };

  /** A nonce issued to alice for row `id`, and the begin input that spends it. */
  async function issued(id: string, t = a, account = "alice.near") {
    const nonce = freshNonce();
    const r = await issueConfirmNonce(db, t, id, nonce, account);
    if (!r.ok) throw new Error(`not issued: ${JSON.stringify(r)}`);
    const input: BeginInput = {
      tenantId: t,
      id,
      nonce,
      account,
      message: "Probarion confirm v1 | pay …",
      publicKey: PK,
      signature: SIG,
      keyBlockHeight: 190000000,
      keyBlockHash: BLOCK_HASH,
      requestId: "req-confirm",
    };
    return { nonce, issue: r, input };
  }

  /** The columns a refused call must leave as they were. */
  const snapshot = async (id: string) =>
    (
      await pg.query(
        `select status, suggested_amount, mandate_id, invoice_hash, outcome, confirmed_by, confirmed_at,
                confirm_message, confirm_public_key, confirm_signature, confirm_nonce, confirm_key_block_height,
                confirm_key_block_hash, rejected_by, fingerprint_sha256, invoice_number_hmac, request_id
         from invoices where id = $1`,
        [id],
      )
    ).rows[0];

  it("issues a nonce for one row snapshot, readable by the service role only", async () => {
    const id = await waiting(a, "20000000", {}, 4);
    const { nonce, issue } = await issued(id);
    expect(issue).toMatchObject({
      ok: true,
      invoice_id: id,
      suggested_amount: "20000000",
      mandate_id: 4,
      invoice_hash: (await getInvoice(db, a, id))?.invoice_hash,
    });
    expect(issue.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const left = Date.parse(issue.expires_at) - Date.now();
    expect(left).toBeGreaterThan(4 * 60_000);
    expect(left).toBeLessThanOrEqual(5 * 60_000);
    expect(await readConfirmNonce(db, nonce)).toMatchObject({
      purpose: "confirm",
      tenant_id: a,
      invoice_id: id,
      issued_to: "alice.near",
      suggested_amount: "20000000",
      mandate_id: 4,
      used: false,
      expired: false,
    });
    expect(await readConfirmNonce(db, freshNonce())).toBeNull();
    for (const role of ["authenticated", "anon"] as const) {
      await expect(
        asRole(pg, role, "alice.near", (tx) =>
          tx.query("select 1 from public.invoice_confirm_nonces"),
        ),
        role,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("issues nothing for a row that does not wait, or has no mandate on it", async () => {
    const upload = (await insertInvoice(db, a, invoice())).id;
    expect(await issueConfirmNonce(db, a, upload, freshNonce(), "alice.near")).toEqual({
      ok: false,
      reason: "not_awaiting",
      status: "processing",
    });
    const noMandate = (await insertInvoice(db, a, invoice())).id;
    await setInvoiceOutcome(db, a, noMandate, {
      status: "awaiting_owner",
      outcome: WAITING as never,
      suggestedAmount: "5",
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
    expect(await issueConfirmNonce(db, a, noMandate, freshNonce(), "alice.near")).toEqual({
      ok: false,
      reason: "no_mandate",
      status: "awaiting_owner",
    });
    await expect(issueConfirmNonce(db, b, upload, freshNonce(), "bob.near")).rejects.toMatchObject({
      code: "not_found",
    });
    // A nonce is issued once: the same bytes again are refused.
    const id = await waiting();
    const { nonce } = await issued(id);
    await expect(issueConfirmNonce(db, a, id, nonce, "alice.near")).rejects.toThrow();
  });

  it("burns the nonce and moves the row to processing in one step, recording the signed confirmation", async () => {
    const id = await waiting(a, "20000000", {}, 2);
    const { nonce, input } = await issued(id);
    expect(await beginConfirmation(db, input)).toEqual({ ok: true, status: "processing" });
    expect(await getInvoice(db, a, id)).toMatchObject({
      status: "processing",
      suggested_amount: "20000000",
      mandate_id: 2,
      confirmed_by: "alice.near",
      confirm_message: "Probarion confirm v1 | pay …",
      confirm_public_key: PK,
      confirm_signature: SIG,
      confirm_nonce: nonce,
      confirm_key_block_height: 190000000,
      confirm_key_block_hash: BLOCK_HASH,
      request_id: "req-confirm",
    });
    expect((await readConfirmNonce(db, nonce))?.used).toBe(true);
    // The same nonce again: refused, and nothing changes.
    const before = await snapshot(id);
    expect(await beginConfirmation(db, input)).toMatchObject({ ok: false, reason: "nonce_used" });
    expect(await snapshot(id)).toEqual(before);
  });

  it("pays once under two parallel confirmations, each with its own nonce", async () => {
    const id = await waiting();
    // Two accounts, since a new nonce for the same row and account ends the earlier one.
    const one = await issued(id);
    const two = await issued(id, a, "carol.near");
    const results = await Promise.all([
      beginConfirmation(db, { ...one.input, requestId: "one" }),
      beginConfirmation(db, { ...two.input, requestId: "two" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "not_awaiting", status: "processing" },
    ]);
  });

  it("refuses an expired nonce, a nonce issued for another row, account or vault, and an unknown one", async () => {
    const id = await waiting();
    const other = await waiting();
    const before = await snapshot(id);

    const expired = await issued(id);
    await pg.query(
      "update invoice_confirm_nonces set expires_at = now() - interval '1 second' where nonce = $1",
      [expired.nonce],
    );
    expect(await beginConfirmation(db, expired.input)).toMatchObject({
      ok: false,
      reason: "expired",
    });

    const forOther = await issued(other);
    expect(await beginConfirmation(db, { ...forOther.input, id })).toMatchObject({
      ok: false,
      reason: "nonce_mismatch",
    });
    const forBob = await issued(id, a, "bob.near");
    expect(await beginConfirmation(db, { ...forBob.input, account: "alice.near" })).toMatchObject({
      ok: false,
      reason: "nonce_mismatch",
    });
    const theirs = await waiting(b, "20000000");
    const forB = await issued(theirs, b, "bob.near");
    expect(
      await beginConfirmation(db, { ...forB.input, tenantId: a, id, account: "bob.near" }),
    ).toMatchObject({ ok: false, reason: "nonce_mismatch" });

    expect(await beginConfirmation(db, { ...expired.input, nonce: freshNonce() })).toMatchObject({
      ok: false,
      reason: "nonce_unknown",
    });

    expect(await snapshot(id)).toEqual(before);
    // Each refused attempt burned its nonce: it cannot be tried again, even on its own row.
    expect(await beginConfirmation(db, forOther.input)).toMatchObject({ reason: "nonce_used" });
    expect((await getInvoice(db, a, other))?.status).toBe("awaiting_owner");
  });

  it("refuses a row that changed between the nonce and the confirmation", async () => {
    const id = await waiting(a, "20000000");
    const { input } = await issued(id);
    // While the row waits, its suggestion, mandate and hash cannot change at all.
    for (const sql of [
      "update invoices set suggested_amount = '20000001' where id = $1",
      "update invoices set mandate_id = 9 where id = $1",
      `update invoices set invoice_hash = '${H("e")}' where id = $1`,
    ]) {
      await expect(pg.query(sql, [id]), sql).rejects.toThrow(/invoice_snapshot_frozen/);
    }
    // It can change once it left awaiting_owner (an attempt that went back to processing, a new suggestion).
    await pg.query("update invoices set status = 'processing' where id = $1", [id]);
    await pg.query("update invoices set suggested_amount = '20000001' where id = $1", [id]);
    await pg.query("update invoices set status = 'awaiting_owner' where id = $1", [id]);
    const before = await snapshot(id);
    expect(await beginConfirmation(db, input)).toEqual({
      ok: false,
      reason: "row_changed",
      status: "awaiting_owner",
    });
    expect(await snapshot(id)).toEqual(before);
  });

  it("re-runs the duplicate guard: a paid or pending row with the same fingerprint or number blocks", async () => {
    const num = H("5");
    const paid = (
      await insertInvoice(db, a, invoice({ fingerprint: H("4"), invoiceNumberKey: num }))
    ).id;
    await setInvoiceOutcome(db, a, paid, {
      status: "decided",
      outcome: PAID as never,
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
    // The keys are forced onto a waiting row as if it had been written before the paid one existed.
    const id = await waiting(a, "20000000", { fingerprint: H("3") });
    await pg.query("update invoices set invoice_number_hmac = $2 where id = $1", [id, num]);
    const { input } = await issued(id);
    const before = await snapshot(id);
    expect(await beginConfirmation(db, input)).toEqual({
      ok: false,
      reason: "duplicate",
      status: "awaiting_owner",
      duplicate_id: paid,
      duplicate_status: "decided",
    });
    expect(await snapshot(id)).toEqual(before);

    // A row of the same fingerprint that is still processing blocks too.
    const busy = (await insertInvoice(db, a, invoice({ fingerprint: H("8") }))).id;
    const other = await waiting(a, "5", { fingerprint: H("9") });
    await pg.query("update invoices set fingerprint_sha256 = $2 where id = $1", [other, H("8")]);
    expect(await beginConfirmation(db, (await issued(other)).input)).toMatchObject({
      ok: false,
      reason: "duplicate",
      duplicate_id: busy,
      duplicate_status: "processing",
    });

    // Another waiting row, a refused one and another vault's paid row do not block.
    const fp = H("6");
    const free = await waiting(a, "7", { fingerprint: fp });
    const twin = await waiting(a, "7", { fingerprint: H("2") });
    await pg.query("update invoices set fingerprint_sha256 = $1 where id = $2", [fp, twin]);
    const refused = (await insertInvoice(db, a, invoice({ fingerprint: H("1") }))).id;
    await setInvoiceOutcome(db, a, refused, {
      status: "decided",
      outcome: { ...WAITING, status: "refused_by_code", code: "mandate.none" } as never,
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
    await pg.query("update invoices set fingerprint_sha256 = $1 where id = $2", [fp, refused]);
    const theirs = (await insertInvoice(db, b, invoice({ fingerprint: fp }))).id;
    await setInvoiceOutcome(db, b, theirs, {
      status: "decided",
      outcome: PAID as never,
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
    expect(await beginConfirmation(db, (await issued(free)).input)).toEqual({
      ok: true,
      status: "processing",
    });
  });

  it("burns a nonce on its own after a refused signature, and only a known one", async () => {
    const id = await waiting();
    const { nonce, input } = await issued(id);
    expect(await burnConfirmNonce(db, nonce)).toEqual({ burned: true });
    expect(await burnConfirmNonce(db, nonce)).toEqual({ burned: false });
    expect(await burnConfirmNonce(db, freshNonce())).toEqual({ burned: false });
    expect(await beginConfirmation(db, input)).toMatchObject({ ok: false, reason: "nonce_used" });
    expect((await getInvoice(db, a, id))?.status).toBe("awaiting_owner");
  });

  it("undoes a confirmation whose cycle stopped before sending anything, and nothing else", async () => {
    const id = await waiting(a, "9");
    const before = await snapshot(id);
    await beginConfirmation(db, (await issued(id)).input);
    expect(await abortConfirmation(db, a, id)).toEqual({ changed: true, status: "awaiting_owner" });
    expect(await snapshot(id)).toEqual({ ...(before as object), request_id: "req-confirm" });
    // A row in processing that no confirmation moved there (an upload's cycle) is never sent back to waiting.
    const upload = (await insertInvoice(db, a, invoice())).id;
    expect(await abortConfirmation(db, a, upload)).toEqual({
      changed: false,
      status: "processing",
    });
    // Nor is a waiting row moved to processing by anything but a confirmation (it keeps its suggestion and mandate).
    const moved = await waiting(a, "13");
    await pg.query("update invoices set status = 'processing' where id = $1", [moved]);
    expect(await abortConfirmation(db, a, moved)).toEqual({ changed: false, status: "processing" });
    // Nor is a row whose confirmed cycle already recorded its outcome.
    await beginConfirmation(db, (await issued(id)).input);
    await setInvoiceOutcome(db, a, id, {
      status: "decided",
      outcome: PAID as never,
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
    expect(await abortConfirmation(db, a, id)).toEqual({ changed: false, status: "decided" });
    expect(await getInvoice(db, a, id)).toMatchObject({ mandate_id: 1, suggested_amount: null });
  });

  it("keeps the confirmation when the confirmed cycle was held again, and the row waits again", async () => {
    const id = await waiting(a, "11");
    await beginConfirmation(db, (await issued(id)).input);
    await setInvoiceOutcome(db, a, id, {
      status: "awaiting_owner",
      outcome: { ...WAITING, code: "intents.balance_low" } as never,
      suggestedAmount: "11",
      mandateId: 1,
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
    expect(await getInvoice(db, a, id)).toMatchObject({
      status: "awaiting_owner",
      suggested_amount: "11",
      confirmed_by: "alice.near",
      outcome: { code: "intents.balance_low" },
    });
    expect(await beginConfirmation(db, (await issued(id)).input)).toMatchObject({ ok: true });
  });

  it("refuses malformed input before reading any row", async () => {
    const id = await waiting();
    const { nonce } = await issued(id);
    const p = {
      tenant_id: a,
      id,
      nonce,
      account: "alice.near",
      message: "m",
      public_key: PK,
      signature: SIG,
      key_block_height: 1,
      key_block_hash: BLOCK_HASH,
      request_id: "r",
    };
    for (const bad of [
      { ...p, tenant_id: "x" },
      { ...p, id: "x" },
      { ...p, nonce: "ab" },
      { ...p, nonce: H("G") },
      { ...p, account: "" },
      { ...p, message: "" },
      { ...p, message: "x".repeat(2001) },
      { ...p, public_key: "secp256k1:abc" },
      { ...p, public_key: null },
      { ...p, signature: "c2ln" },
      { ...p, signature: `${SIG}x` },
      { ...p, key_block_height: -1 },
      { ...p, key_block_height: "x" },
      { ...p, key_block_hash: "" },
      { ...p, request_id: "" },
    ]) {
      await expect(db.rpc("invoice_confirm_begin", bad), JSON.stringify(bad)).rejects.toMatchObject(
        {
          code: "invalid_input",
        },
      );
    }
    for (const bad of [
      { tenant_id: a, id, nonce: "x", issued_to: "alice.near" },
      { tenant_id: a, id, nonce: freshNonce(), issued_to: "" },
    ]) {
      await expect(db.rpc("invoice_confirm_issue", bad)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect((await readConfirmNonce(db, nonce))?.used).toBe(false);
    expect((await getInvoice(db, a, id))?.status).toBe("awaiting_owner");
  });

  it("holds a confirmation whole: its columns are set together or not at all", async () => {
    const id = await waiting();
    await expect(
      pg.query("update invoices set confirmed_by = 'x.near' where id = $1", [id]),
    ).rejects.toThrow(/invoices_confirmation_whole/);
  });

  it("rejects a waiting row once, with the snapshot the owner saw, and frees its guard keys", async () => {
    const id = await waiting(a, "30000000", { fingerprint: H("c"), invoiceNumberKey: H("e") }, 3);
    const row = await getInvoice(db, a, id);
    if (!row) throw new Error("no row");
    const seen = { suggestedAmount: "30000000", invoiceHash: row.invoice_hash, mandateId: 3 };
    // While it waits, a re-upload with the same number is a duplicate.
    expect((await insertInvoice(db, a, invoice({ invoiceNumberKey: H("e") }))).duplicate).toBe(
      true,
    );
    // Another snapshot than the row's (the owner saw an older suggestion, or another mandate) changes nothing.
    const before = await snapshot(id);
    for (const other of [
      { ...seen, suggestedAmount: "30000001" },
      { ...seen, mandateId: 4 },
      { ...seen, invoiceHash: H("0") },
    ]) {
      expect(await setInvoiceRejected(db, a, id, "alice.near", other)).toEqual({
        changed: false,
        status: "awaiting_owner",
      });
    }
    expect(await snapshot(id)).toEqual(before);
    expect(await setInvoiceRejected(db, a, id, "alice.near", seen)).toEqual({
      changed: true,
      status: "rejected",
    });
    expect(await getInvoice(db, a, id)).toMatchObject({
      status: "rejected",
      rejected_by: "alice.near",
      suggested_amount: "30000000",
    });
    expect(await snapshot(id)).toMatchObject({
      fingerprint_sha256: null,
      invoice_number_hmac: null,
    });
    // A corrected re-upload with the same number or text is a new invoice now.
    expect((await insertInvoice(db, a, invoice({ invoiceNumberKey: H("e") }))).duplicate).toBe(
      false,
    );
    expect((await insertInvoice(db, a, invoice({ fingerprint: H("c") }))).duplicate).toBe(false);
    // A second Reject, and a nonce for it, change nothing.
    const after = await snapshot(id);
    expect(await setInvoiceRejected(db, a, id, "x.near", seen)).toEqual({
      changed: false,
      status: "rejected",
    });
    expect(await issueConfirmNonce(db, a, id, freshNonce(), "alice.near")).toMatchObject({
      ok: false,
      reason: "not_awaiting",
    });
    expect(await snapshot(id)).toEqual(after);
    // Reject is only for a waiting row: a processing one stays as it is.
    const upload = (await insertInvoice(db, a, invoice())).id;
    const up = await getInvoice(db, a, upload);
    expect(
      await setInvoiceRejected(db, a, upload, "alice.near", {
        suggestedAmount: "1",
        invoiceHash: up?.invoice_hash ?? "",
        mandateId: 1,
      }),
    ).toEqual({ changed: false, status: "processing" });
    await expect(setInvoiceRejected(db, b, id, "bob.near", seen)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      db.rpc("invoice_reject", { tenant_id: a, id, rejected_by: "", ...seen }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a new nonce for the same row and owner ends the earlier live one, and leaves others alone", async () => {
    const id = await waiting();
    const other = await waiting();
    const first = await issued(id);
    const forOtherRow = await issued(other);
    const forOtherAccount = await issued(id, a, "carol.near");
    const second = await issued(id);
    expect((await readConfirmNonce(db, first.nonce))?.used).toBe(true);
    expect((await readConfirmNonce(db, second.nonce))?.used).toBe(false);
    expect((await readConfirmNonce(db, forOtherRow.nonce))?.used).toBe(false);
    expect((await readConfirmNonce(db, forOtherAccount.nonce))?.used).toBe(false);
    expect(await beginConfirmation(db, first.input)).toMatchObject({
      ok: false,
      reason: "nonce_used",
    });
    expect(await beginConfirmation(db, second.input)).toEqual({ ok: true, status: "processing" });
  });

  it("sweeps expired nonces for the whole tenant when one is issued, and no other tenant's", async () => {
    const stale = await issued(await waiting());
    const theirs = await issued(await waiting(b), b, "bob.near");
    const live = await issued(await waiting());
    await pg.query(
      "update invoice_confirm_nonces set expires_at = now() - interval '1 second' where nonce = any($1)",
      [[stale.nonce, theirs.nonce]],
    );
    await issued(await waiting());
    expect(await readConfirmNonce(db, stale.nonce)).toBeNull();
    expect(await readConfirmNonce(db, live.nonce)).not.toBeNull();
    expect(await readConfirmNonce(db, theirs.nonce)).toMatchObject({ expired: true });
  });

  it("rejects a waiting row that has no mandate, with a snapshot that says so", async () => {
    const { id } = await insertInvoice(db, a, invoice());
    await setInvoiceOutcome(db, a, id, {
      status: "awaiting_owner",
      outcome: WAITING as never,
      suggestedAmount: "15",
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
    const row = await getInvoice(db, a, id);
    if (!row) throw new Error("no row");
    const seen = { suggestedAmount: "15", invoiceHash: row.invoice_hash };
    // A snapshot that names a mandate does not match a row without one, and the reverse.
    expect(await setInvoiceRejected(db, a, id, "alice.near", { ...seen, mandateId: 1 })).toEqual({
      changed: false,
      status: "awaiting_owner",
    });
    const withMandate = await waiting(a, "15", {}, 3);
    const other = await getInvoice(db, a, withMandate);
    expect(
      await setInvoiceRejected(db, a, withMandate, "alice.near", {
        suggestedAmount: "15",
        invoiceHash: other?.invoice_hash ?? "",
        mandateId: null,
      }),
    ).toEqual({ changed: false, status: "awaiting_owner" });
    expect(await setInvoiceRejected(db, a, id, "alice.near", { ...seen, mandateId: null })).toEqual(
      {
        changed: true,
        status: "rejected",
      },
    );
    // A malformed mandate is refused.
    await expect(
      db.rpc("invoice_reject", {
        tenant_id: a,
        id: withMandate,
        rejected_by: "alice.near",
        suggested_amount: "15",
        invoice_hash: other?.invoice_hash,
        mandate_id: "x",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  describe("the payee's invoices of the last 90 days", () => {
    let t: string;
    /** A decided row under `mandate` (or none), its creation moved `daysAgo` into the past. */
    async function row(mandate: number | null, daysAgo = 0) {
      const { id } = await insertInvoice(db, t, invoice());
      await setInvoiceOutcome(db, t, id, {
        status: "decided",
        outcome: { ...WAITING, status: "refused_by_code", code: "x" } as never,
        ...(mandate === null ? {} : { mandateId: mandate }),
        anchorTxHash: null,
        promptTokens: null,
        completionTokens: null,
      });
      await pg.query(
        `update invoices set created_at = now() - make_interval(days => $2) where id = $1`,
        [id, daysAgo],
      );
      return id;
    }

    beforeAll(async () => {
      t = await seedTenant(pg, { vault: "c.vaults.probarion.near", owner: "carol.near" });
    });

    it("finds rows by mandate and by a ledger decision, past any page, newest first", async () => {
      const newest = await row(7, 0);
      const older = await row(8, 2);
      const noMandate = await row(null, 3);
      const row4 = await row(7, 4);
      const inWindow = await row(7, 89);
      await row(7, 91); // outside the 90 days
      await row(9, 1); // another payee's mandate
      const elsewhere = await row(null, 1); // no mandate, no decision of this payee
      const decided = await getInvoice(db, t, noMandate);
      const other = await getInvoice(db, t, elsewhere);
      const decision = (seq: number, hash: string | undefined, mandate: number) =>
        pg.query(
          `insert into ledger_entries (tenant_id, seq, kind, body, body_hash, sig, signer, link, request_id)
           values ($1, $2, 'decision', $3, $4, 'ed25519:s', 'ed25519:p', $4, 'r')`,
          [
            t,
            seq,
            JSON.stringify({ kind: "decision", invoice_hash: hash, mandate_id: mandate }),
            seq.toString(16).padStart(64, "c"),
          ],
        );
      await decision(0, decided?.invoice_hash, 7);
      await decision(1, other?.invoice_hash, 9);
      const want = [newest, older, noMandate, row4, inWindow];
      for (const pageSize of [500, 2, 1]) {
        const got = await listPayeeRecent(db, t, [7, 8], pageSize);
        expect(
          got.map((r) => r.id),
          `page size ${pageSize}`,
        ).toEqual(want);
      }
      // No mandates: nothing to match. Another tenant's rows are not seen.
      expect(await listPayeeRecent(db, t, [])).toEqual([]);
      expect(await listPayeeRecent(db, a, [8])).toEqual([]);
    });

    it("refuses malformed input, and anyone but the service role", async () => {
      for (const bad of [
        { tenant_id: "x", mandate_ids: [] },
        { tenant_id: t, mandate_ids: "7" },
        { tenant_id: t },
        { tenant_id: t, mandate_ids: ["7; drop table x"] },
        { tenant_id: t, mandate_ids: [0] },
        { tenant_id: t, mandate_ids: [], after: { created_at: "x", id: "y" } },
      ]) {
        await expect(db.rpc("invoice_payee_recent", bad), JSON.stringify(bad)).rejects.toThrow();
      }
      for (const role of ["authenticated", "anon"] as const) {
        await expect(
          asRole(pg, role, "alice.near", (tx) =>
            tx.query("select public.invoice_payee_recent('{}'::jsonb)"),
          ),
          role,
        ).rejects.toThrow(/permission denied/);
      }
    });
  });

  it("reads a retained invoice's sealed content for the service role only", async () => {
    const id = await waiting();
    expect(await invoiceContent(db, a, id)).toEqual({ mediaType: "text/plain", sealed: SEALED });
    expect(await invoiceContent(db, b, id)).toBeNull();
    const zero = (
      await insertInvoice(db, a, invoice({ sealed: null, facts: null, filename: null }))
    ).id;
    expect(await invoiceContent(db, a, zero)).toBeNull();
    for (const role of ["authenticated", "anon"] as const) {
      for (const fn of [
        "invoice_content",
        "invoice_confirm_issue",
        "invoice_confirm_nonce",
        "invoice_confirm_begin",
        "invoice_confirm_burn",
        "invoice_confirm_abort",
        "invoice_reject",
      ]) {
        await expect(
          asRole(pg, role, "alice.near", (tx) => tx.query(`select public.${fn}('{}'::jsonb)`)),
          `${role} ${fn}`,
        ).rejects.toThrow(/permission denied/);
      }
    }
  });

  it("lets a member read the confirmation, the mandate and the rejection, never the sealed content", async () => {
    const id = await waiting();
    await beginConfirmation(db, (await issued(id)).input);
    const seen = await asRole(pg, "authenticated", "alice.near", (tx) =>
      tx.query(
        `select mandate_id, confirmed_by, confirm_message, confirm_public_key, confirm_signature, confirm_nonce,
                confirm_key_block_height, rejected_by from public.invoices where id = $1`,
        [id],
      ),
    );
    expect(seen.rows).toEqual([
      {
        mandate_id: 1,
        confirmed_by: "alice.near",
        confirm_message: "Probarion confirm v1 | pay …",
        confirm_public_key: PK,
        confirm_signature: SIG,
        confirm_nonce: expect.stringMatching(/^[0-9a-f]{64}$/),
        confirm_key_block_height: 190000000,
        rejected_by: null,
      },
    ]);
    await expect(
      asRole(pg, "authenticated", "alice.near", (tx) =>
        tx.query("select content_nonce from public.invoices where id = $1", [id]),
      ),
    ).rejects.toThrow(/permission denied/);
    expect(id).toMatch(UUID);
  });
});
