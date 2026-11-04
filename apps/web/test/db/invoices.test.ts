import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/port";
import { AMOUNT_ISSUES } from "@/lib/payables/amount";
import {
  getInvoice,
  insertInvoice,
  listInvoices,
  type NewInvoice,
  setInvoiceOutcome,
} from "@/lib/payables/store";
import { asRole, freshDb, seedTenant } from "./harness";
import { pgliteDb } from "./pglite-db";

// The invoice functions of migration 0006, on their own (the pipeline's tests use them end to end).

const H = (c: string) => c.repeat(64);
const SEALED = { ciphertext: "Y2lwaGVy", nonce: "bm9uY2U=" };
const OUTCOME = {
  status: "paid",
  spendId: 1,
  code: null,
  txHash: "TX1",
  ledgerSeq: 1,
  decisionHash: H("d"),
  anchorTxHash: null,
};

describe("invoice functions (migration 0006)", () => {
  let pg: PGlite;
  let db: Db;
  let a: string;
  let b: string;
  let n = 0;

  beforeAll(async () => {
    pg = await freshDb();
    db = pgliteDb(pg);
    a = await seedTenant(pg, { vault: "a.vaults.probarion.near", owner: "alice.near" });
    b = await seedTenant(pg, { vault: "b.vaults.probarion.near", owner: "bob.near" });
  });
  afterAll(async () => {
    await pg.close();
  });

  /** A new invoice with its own hash and ref. */
  function invoice(over: Partial<NewInvoice> = {}): NewInvoice {
    n += 1;
    const hash = n.toString(16).padStart(64, "0");
    return {
      invoiceHash: hash,
      ref: `inv-${hash.slice(-24)}`,
      filename: "inv.pdf",
      mediaType: "application/pdf",
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

  const decide = (tenant: string, id: string, status: string) =>
    setInvoiceOutcome(db, tenant, id, {
      status: "decided",
      outcome: { ...OUTCOME, status } as never,
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });

  it("refuses an invoice whose normalised text matches one that is processing or paid", async () => {
    const { id } = await insertInvoice(db, a, invoice({ fingerprint: H("a") }));
    // Another text (another hash and ref) with the same fingerprint: a re-upload with other spaces or line ends.
    const again = () => insertInvoice(db, a, invoice({ fingerprint: H("a") }));
    expect(await again()).toEqual({ id, duplicate: true, status: "processing" });
    await decide(a, id, "paid");
    expect(await again()).toEqual({ id, duplicate: true, status: "decided" });
    // Another vault may hold the same text.
    expect(await insertInvoice(db, b, invoice({ fingerprint: H("a") }))).toMatchObject({
      duplicate: false,
    });
  });

  it.each([
    ["held", true],
    ["burned", true],
    ["settled", true],
    ["refused_by_code", false],
    ["refused_by_contract", false],
    ["failed", false],
  ])(
    "after a decided outcome %s, a matching re-upload is a duplicate: %s",
    async (status, blocks) => {
      const fp = (n + 7000).toString(16).padStart(64, "0");
      const { id } = await insertInvoice(db, a, invoice({ fingerprint: fp }));
      await decide(a, id, status);
      expect((await insertInvoice(db, a, invoice({ fingerprint: fp }))).duplicate).toBe(blocks);
    },
  );

  it("does not block a re-upload of an invoice a rule held by code: nothing was sent for it", async () => {
    const fp = (n + 9000).toString(16).padStart(64, "0");
    const { id } = await insertInvoice(db, a, invoice({ fingerprint: fp }));
    await setInvoiceOutcome(db, a, id, {
      status: "decided",
      outcome: {
        ...OUTCOME,
        status: "held",
        spendId: null,
        txHash: null,
        code: "intents.balance_low",
      } as never,
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
    expect((await insertInvoice(db, a, invoice({ fingerprint: fp }))).duplicate).toBe(false);
  });

  it("refuses an invoice whose number matches one that is unconfirmed, but not one that ended in error", async () => {
    const { id } = await insertInvoice(db, a, invoice({ invoiceNumberKey: H("b") }));
    await setInvoiceOutcome(db, a, id, {
      status: "unconfirmed",
      outcome: { ...OUTCOME, status: "unconfirmed" } as never,
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
    expect(await insertInvoice(db, a, invoice({ invoiceNumberKey: H("b") }))).toEqual({
      id,
      duplicate: true,
      status: "unconfirmed",
    });
    const { id: failed } = await insertInvoice(db, a, invoice({ invoiceNumberKey: H("c") }));
    await setInvoiceOutcome(db, a, failed, { status: "error", error: "rpc down" });
    expect(await insertInvoice(db, a, invoice({ invoiceNumberKey: H("c") }))).toMatchObject({
      duplicate: false,
    });
  });

  it("refuses a malformed fingerprint or invoice-number hash", async () => {
    for (const over of [{ fingerprint: "nope" }, { invoiceNumberKey: "XYZ" }]) {
      await expect(insertInvoice(db, a, invoice(over))).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
  });

  it("is executable by the service role only", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      for (const fn of ["invoice_insert", "invoice_set_outcome", "invoice_list", "invoice_get"]) {
        await expect(pgliteDb(pg, role, "alice.near").rpc(fn, { tenant_id: a })).rejects.toThrow(
          /permission denied/,
        );
      }
    }
  });

  it("inserts once per ref and answers a duplicate with the row's status", async () => {
    const inv = invoice();
    const first = await insertInvoice(db, a, inv);
    expect(first).toMatchObject({ duplicate: false, retry: false });
    expect(await insertInvoice(db, a, inv)).toEqual({
      id: first.id,
      duplicate: true,
      status: "processing",
    });
    // The same ref under another tenant is another invoice.
    expect(await insertInvoice(db, b, inv)).toMatchObject({ duplicate: false });
  });

  it("refuses malformed input as invalid_input, not as a constraint error", async () => {
    const bad: Partial<NewInvoice>[] = [
      { invoiceHash: "XYZ" },
      { ref: "" },
      { ref: "r".repeat(65) },
      { mediaType: "image/png" as NewInvoice["mediaType"] },
      { filename: "f".repeat(201) },
      { documentSha256: "nope" },
      { requestId: "" },
      { createdBy: "" },
      { sealed: null }, // zero retention with facts and a file name
      { sealed: null, facts: null }, // zero retention with a file name
      { sealed: { ciphertext: "", nonce: "" } },
      { amountIssue: "made_up" as NewInvoice["amountIssue"] },
    ];
    for (const over of bad) {
      await expect(insertInvoice(db, a, invoice(over))).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    await expect(
      insertInvoice(db, a, invoice({ sealed: null, facts: null, filename: null })),
    ).resolves.toMatchObject({ duplicate: false });
    await expect(db.rpc("invoice_insert", { tenant_id: "not-a-uuid" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("never retains an invoice for a tenant in zero-retention mode, whatever the caller read", async () => {
    const z = await seedTenant(pg, { vault: "z.vaults.probarion.near", owner: "zed.near" });
    await pg.query("update tenants set zero_retention = true where id = $1", [z]);
    // A caller that read the setting before the owner turned it on still sends retained content.
    await expect(insertInvoice(db, z, invoice())).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/zero-retention/),
    });
    expect((await pg.query("select 1 from invoices where tenant_id = $1", [z])).rows).toHaveLength(
      0,
    );
    // Hashes only is what the tenant gets, with why the amount was refused kept.
    const hashOnly = await insertInvoice(
      db,
      z,
      invoice({ sealed: null, facts: null, filename: null, amountIssue: "ambiguous" }),
    );
    expect(await getInvoice(db, z, hashOnly.id)).toMatchObject({
      retained: false,
      facts: null,
      amount_issue: "ambiguous",
    });
    // An error row is not taken over with retained content either (the retry path).
    await setInvoiceOutcome(db, z, hashOnly.id, { status: "error", error: "x" });
    const row = await getInvoice(db, z, hashOnly.id);
    await expect(
      insertInvoice(db, z, invoice({ invoiceHash: row?.invoice_hash ?? "", ref: row?.ref ?? "" })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      db.rpc("invoice_insert", {
        tenant_id: "00000000-0000-4000-8000-00000000dead",
        invoice_hash: H("1"),
        ref: "inv-x",
        media_type: "text/plain",
        retained: false,
        request_id: "r",
        created_by: "x",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps no file name for a zero-retention row, even written by hand", async () => {
    await expect(
      pg.query(
        `insert into invoices (tenant_id, invoice_hash, ref, filename, media_type, retained, request_id, created_by)
         values ($1, $2, 'inv-hand', 'secret-name.pdf', 'application/pdf', false, 'r', 'x')`,
        [a, H("9")],
      ),
    ).rejects.toThrow(/invoices_retention/);
  });

  it("sets the outcome once, only while processing, and only on the tenant's own row", async () => {
    const { id } = await insertInvoice(db, a, invoice());
    await expect(
      setInvoiceOutcome(db, b, id, {
        status: "decided",
        outcome: OUTCOME as never,
        anchorTxHash: null,
        promptTokens: null,
        completionTokens: null,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    const r = await setInvoiceOutcome(db, a, id, {
      status: "decided",
      outcome: OUTCOME as never,
      anchorTxHash: "A".repeat(44),
      promptTokens: 10,
      completionTokens: 2,
    });
    expect(r).toEqual({ id, status: "decided", changed: true });
    // A late writer never overwrites it.
    expect(await setInvoiceOutcome(db, a, id, { status: "error", error: "late" })).toEqual({
      id,
      status: "decided",
      changed: false,
    });
    expect(await getInvoice(db, a, id)).toMatchObject({
      status: "decided",
      error: null,
      anchor_tx_hash: "A".repeat(44),
      model_prompt_tokens: 10,
      model_completion_tokens: 2,
      outcome: { status: "paid", txHash: "TX1" },
    });
  });

  it("refuses an outcome that hides an unconfirmed payment, or that is malformed", async () => {
    const { id } = await insertInvoice(db, a, invoice());
    const base = { tenant_id: a, id, outcome: OUTCOME, error: null };
    for (const p of [
      { ...base, status: "decided", outcome: { ...OUTCOME, status: "unconfirmed" } },
      { ...base, status: "decided", outcome: null },
      { ...base, status: "error", error: "" },
      { ...base, status: "error" }, // an error carries no outcome
      { ...base, status: "paid" },
      { ...base, status: "decided", anchor_tx_hash: "not base58!" },
      { ...base, status: "decided", model_prompt_tokens: -1 },
    ]) {
      await expect(db.rpc("invoice_set_outcome", p)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    await expect(
      db.rpc("invoice_set_outcome", {
        ...base,
        status: "unconfirmed",
        outcome: { ...OUTCOME, status: "unconfirmed" },
      }),
    ).resolves.toMatchObject({ status: "unconfirmed", changed: true });
  });

  /** An outcome the owner-confirms rule decided: nothing was sent. */
  const WAITING = {
    ...OUTCOME,
    status: "held",
    spendId: null,
    code: "custom.owner_confirms_without_model",
    txHash: null,
  };

  it("records an invoice waiting for the owner only with a sent-nothing outcome and the code's amount", async () => {
    const { id } = await insertInvoice(db, a, invoice());
    const base = { tenant_id: a, id, status: "awaiting_owner", outcome: WAITING, error: null };
    for (const p of [
      { ...base, suggested_amount: null }, // the suggestion is required
      { ...base, suggested_amount: "0" }, // and is a non-zero canonical amount
      { ...base, suggested_amount: "007" },
      { ...base, suggested_amount: "12.5" },
      { ...base, suggested_amount: "5", outcome: { ...WAITING, status: "paid" } },
      { ...base, suggested_amount: "5", outcome: { ...WAITING, spendId: 3 } }, // a spend was sent
      { ...base, suggested_amount: "5", outcome: { ...WAITING, txHash: "TX9" } },
      { ...base, suggested_amount: "5", outcome: null },
      // No other status keeps a suggestion.
      { ...base, status: "decided", suggested_amount: "5" },
      {
        ...base,
        status: "unconfirmed",
        outcome: { ...OUTCOME, status: "unconfirmed" },
        suggested_amount: "5",
      },
    ]) {
      await expect(db.rpc("invoice_set_outcome", p), JSON.stringify(p)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    await expect(
      setInvoiceOutcome(db, a, id, {
        status: "awaiting_owner",
        outcome: WAITING as never,
        suggestedAmount: "770000000",
        anchorTxHash: null,
        promptTokens: null,
        completionTokens: null,
      }),
    ).resolves.toMatchObject({ status: "awaiting_owner", changed: true });
    expect(await getInvoice(db, a, id)).toMatchObject({
      status: "awaiting_owner",
      suggested_amount: "770000000",
      outcome: { code: "custom.owner_confirms_without_model", spendId: null },
    });
    // The table holds the same rule: a waiting row always has its suggestion.
    await expect(
      pg.query("update invoices set suggested_amount = null where id = $1", [id]),
    ).rejects.toThrow(/invoices_awaiting_owner_amount/);
    // A member reads the suggestion; a member of another vault sees no row.
    const seen = await asRole(pg, "authenticated", "alice.near", (tx) =>
      tx.query("select suggested_amount from public.invoices where id = $1", [id]),
    );
    expect(seen.rows).toEqual([{ suggested_amount: "770000000" }]);
  });

  it("refuses a re-upload of an invoice that waits for the owner, by fingerprint or by number", async () => {
    const fp = H("7");
    const { id } = await insertInvoice(
      db,
      a,
      invoice({ fingerprint: fp, invoiceNumberKey: H("8") }),
    );
    await setInvoiceOutcome(db, a, id, {
      status: "awaiting_owner",
      outcome: WAITING as never,
      suggestedAmount: "5",
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
    expect(await insertInvoice(db, a, invoice({ fingerprint: fp }))).toEqual({
      id,
      duplicate: true,
      status: "awaiting_owner",
    });
    expect(await insertInvoice(db, a, invoice({ invoiceNumberKey: H("8") }))).toEqual({
      id,
      duplicate: true,
      status: "awaiting_owner",
    });
  });

  it("takes over only an `error` row of the same invoice", async () => {
    const inv = invoice();
    const { id } = await insertInvoice(db, a, inv);
    await setInvoiceOutcome(db, a, id, { status: "error", error: "rpc down" });
    const retry = await insertInvoice(db, a, { ...inv, requestId: "r2", filename: "again.pdf" });
    expect(retry).toEqual({ id, duplicate: false, retry: true });
    expect(await getInvoice(db, a, id)).toMatchObject({
      status: "processing",
      error: null,
      request_id: "r2",
      filename: "again.pdf",
    });
    // Once decided (or unconfirmed), it is a duplicate for good.
    await setInvoiceOutcome(db, a, id, {
      status: "unconfirmed",
      outcome: { ...OUTCOME, status: "unconfirmed" } as never,
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
    expect(await insertInvoice(db, a, inv)).toMatchObject({
      duplicate: true,
      status: "unconfirmed",
    });
    // An error row whose ref collides with another text's hash is not taken over.
    const other = invoice();
    const { id: otherId } = await insertInvoice(db, a, other);
    await setInvoiceOutcome(db, a, otherId, { status: "error", error: "x" });
    expect(await insertInvoice(db, a, { ...other, invoiceHash: H("7") })).toMatchObject({
      duplicate: true,
      status: "error",
    });
  });

  it("reads only the tenant's own invoices, newest first, and never their sealed content", async () => {
    const mine = await insertInvoice(db, b, invoice({ requestId: "only-b" }));
    expect(await getInvoice(db, a, mine.id)).toBeNull();
    await expect(getInvoice(db, a, "nope")).rejects.toMatchObject({ code: "invalid_input" });
    const list = await listInvoices(db, b, 500);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((i) => !("content_ciphertext" in i) && !("content_nonce" in i))).toBe(true);
    expect((await listInvoices(db, b, 1)).map((i) => i.id)).toEqual([mine.id]);
    const all = await listInvoices(db, a, 500);
    const times = all.map((i) => i.created_at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(all.some((i) => i.id === mine.id)).toBe(false);
  });

  it("lets a member read why the amount was refused, for every reason the reader gives", async () => {
    expect(AMOUNT_ISSUES).toContain("not_payable");
    for (const reason of AMOUNT_ISSUES) {
      const { id } = await insertInvoice(db, a, invoice({ amountIssue: reason }));
      const seen = await asRole(pg, "authenticated", "alice.near", (tx) =>
        tx.query<{ amount_issue: string | null }>(
          "select amount_issue from public.invoices where id = $1",
          [id],
        ),
      );
      expect(seen.rows, reason).toEqual([{ amount_issue: reason }]);
      // A member of another vault sees no row at all.
      const other = await asRole(pg, "authenticated", "bob.near", (tx) =>
        tx.query("select amount_issue from public.invoices where id = $1", [id]),
      );
      expect(other.rows, reason).toEqual([]);
    }
  });

  it("lets a member read the new columns but never the sealed content", async () => {
    const { id } = await insertInvoice(db, a, invoice());
    const seen = await asRole(pg, "authenticated", "alice.near", (tx) =>
      tx.query<{ document_sha256: string; anchor_tx_hash: string | null }>(
        "select document_sha256, anchor_tx_hash from public.invoices where id = $1",
        [id],
      ),
    );
    expect(seen.rows[0]?.document_sha256).toBe(H("f"));
    await expect(
      asRole(pg, "authenticated", "bob.near", (tx) =>
        tx.query("select id from public.invoices where id = $1", [id]),
      ).then((r) => r.rows.length),
    ).resolves.toBe(0);
    await expect(
      asRole(pg, "authenticated", "alice.near", (tx) =>
        tx.query("select content_nonce from public.invoices"),
      ),
    ).rejects.toThrow(/permission denied/);
    // The invoice-number key is the server's alone.
    await expect(
      asRole(pg, "authenticated", "alice.near", (tx) =>
        tx.query("select invoice_number_hmac from public.invoices"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
