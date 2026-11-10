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
  setInvoiceRejected,
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

  it("with the number rule, inserts a number-only match and names the earlier invoice, for decide() to refuse", async () => {
    const { id } = await insertInvoice(db, a, invoice({ invoiceNumberKey: H("e") }));
    await decide(a, id, "paid");
    const earlier = await getInvoice(db, a, id);
    // Another text (another fingerprint) with the same number for the same payee.
    const again = await insertInvoice(db, a, invoice({ invoiceNumberKey: H("e") }), {
      numberRule: true,
    });
    expect(again).toMatchObject({
      duplicate: false,
      retry: false,
      number_match: {
        id,
        invoice_hash: earlier?.invoice_hash,
        status: "decided",
        outcome_status: "paid",
      },
    });
    expect(again.id).not.toBe(id);
    expect(await getInvoice(db, a, again.id)).toMatchObject({ status: "processing" });
    // Without the rule (an app that does not refuse it in decide()), the same number stays a duplicate at intake.
    expect(await insertInvoice(db, a, invoice({ invoiceNumberKey: H("e") }))).toEqual({
      id,
      duplicate: true,
      status: "decided",
    });
  });

  it("with the number rule, still answers the same rendered text as a duplicate, and names no match that cannot pay", async () => {
    const { id } = await insertInvoice(
      db,
      a,
      invoice({ fingerprint: H("5"), invoiceNumberKey: H("6") }),
    );
    await decide(a, id, "paid");
    expect(
      await insertInvoice(db, a, invoice({ fingerprint: H("5") }), { numberRule: true }),
    ).toEqual({ id, duplicate: true, status: "decided" });
    // A refused invoice paid nothing: its number blocks nothing, and no match is named.
    const { id: refused } = await insertInvoice(db, a, invoice({ invoiceNumberKey: H("4") }));
    await decide(a, refused, "refused_by_code");
    expect(
      await insertInvoice(db, a, invoice({ invoiceNumberKey: H("4") }), { numberRule: true }),
    ).toMatchObject({ duplicate: false, number_match: null });
  });

  it("runs a text the number rule refused again on its row once no invoice that may pay has its number", async () => {
    const refusedBy = (tenant: string, id: string, code: string) =>
      setInvoiceOutcome(db, tenant, id, {
        status: "decided",
        outcome: {
          ...OUTCOME,
          status: "refused_by_code",
          spendId: null,
          txHash: null,
          code,
        } as never,
        anchorTxHash: null,
        promptTokens: null,
        completionTokens: null,
      });
    const { id: first } = await insertInvoice(db, a, invoice({ invoiceNumberKey: H("3") }));
    const second = invoice({ invoiceNumberKey: H("3") });
    const { id } = await insertInvoice(db, a, second, { numberRule: true });
    await refusedBy(a, id, "custom.invoice_number_duplicate");
    // While the first may still pay, the same text is a duplicate of its own row; without the rule, 0006's answer
    // names the first, by its number.
    expect(await insertInvoice(db, a, second, { numberRule: true })).toEqual({
      id,
      duplicate: true,
      status: "decided",
    });
    expect(await insertInvoice(db, a, second)).toEqual({
      id: first,
      duplicate: true,
      status: "processing",
    });
    // The first paid nothing after all: the same text runs again on its row and ref, with no match to name.
    await refusedBy(a, first, "mandate.over_total");
    expect(await insertInvoice(db, a, second)).toMatchObject({ id, duplicate: true });
    expect(await insertInvoice(db, a, second, { numberRule: true })).toEqual({
      id,
      duplicate: false,
      retry: true,
      number_match: null,
    });
    expect(await getInvoice(db, a, id)).toMatchObject({ status: "processing", outcome: null });
    // Another rule's refusal is final, as it always was: that row is not run again.
    const other = invoice();
    const { id: otherId } = await insertInvoice(db, a, other, { numberRule: true });
    await refusedBy(a, otherId, "mandate.over_total");
    expect(await insertInvoice(db, a, other, { numberRule: true })).toEqual({
      id: otherId,
      duplicate: true,
      status: "decided",
    });
  });

  /** A refusal outcome with this code; `decisionHash` names the decision entry, when the test writes one. */
  const refuse = (
    tenant: string,
    id: string,
    status: string,
    code: string,
    decisionHash = H("d"),
  ) =>
    setInvoiceOutcome(db, tenant, id, {
      status: "decided",
      outcome: { ...OUTCOME, status, spendId: null, txHash: null, code, decisionHash } as never,
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
  /** The owner's Confirm of a waiting row, as invoice_confirm_begin leaves it: back in processing. */
  const confirmed = (id: string) =>
    pg.query("update invoices set status = 'processing' where id = $1", [id]);
  /** A row that waits for the owner, as the console or the extension leaves it. */
  const awaiting = async (over: Partial<NewInvoice>) => {
    const { id } = await insertInvoice(db, a, invoice(over));
    await setInvoiceOutcome(db, a, id, {
      status: "awaiting_owner",
      outcome: {
        ...OUTCOME,
        status: "held",
        spendId: null,
        txHash: null,
        code: "custom.owner_confirms_without_model",
      } as never,
      suggestedAmount: "5",
      anchorTxHash: null,
      promptTokens: null,
      completionTokens: null,
    });
    return id;
  };
  let keys = 0;
  /** A fingerprint or invoice-number key no other test uses. */
  const key = () => {
    keys += 1;
    return (0x50000000 + keys).toString(16).padStart(64, "0");
  };
  let seqs = 0;
  /** A decision entry of tenant `a` with these rules, by hand (no signature): its body_hash. */
  const decisionEntry = async (rules: { id: string; outcome: string }[]) => {
    const hash = (0xd000 + seqs).toString(16).padStart(64, "e");
    await pg.query(
      `insert into ledger_entries (tenant_id, seq, kind, body, body_hash, sig, signer, link, request_id)
       values ($1, $2, 'decision', $3, $4, 'ed25519:s', 'ed25519:p', $4, 'r')`,
      [a, seqs, JSON.stringify({ kind: "decision", rules }), hash],
    );
    seqs += 1;
    return hash;
  };

  // Migration 0017: an SDK agent paid text A outside the console, and the owner's Confirm of A was refused because A
  // was already paid. Before 0017 that refusal freed A's number, and text B of the same bill (another hash, so it
  // passes invoice.duplicate and the contract's DuplicateInvoice) ran again on its row and could pay.
  it("keeps the number blocked when the owner's Confirm was refused because the text was already paid", async () => {
    const num = key();
    const first = await awaiting({ invoiceNumberKey: num });
    const second = invoice({ invoiceNumberKey: num });
    const { id, number_match } = (await insertInvoice(db, a, second, { numberRule: true })) as {
      id: string;
      number_match: unknown;
    };
    expect(number_match).toMatchObject({ id: first, status: "awaiting_owner" });
    await refuse(a, id, "refused_by_code", "custom.invoice_number_duplicate");
    await confirmed(first);
    await refuse(a, first, "refused_by_code", "invoice.duplicate");
    // The same text is a duplicate of its own row: it does not run again.
    expect(await insertInvoice(db, a, second, { numberRule: true })).toEqual({
      id,
      duplicate: true,
      status: "decided",
    });
    expect(await getInvoice(db, a, id)).toMatchObject({
      outcome: { code: "custom.invoice_number_duplicate" },
    });
    // A third text with the number runs, and the number rule refuses it: the match names the refused invoice.
    expect(
      await insertInvoice(db, a, invoice({ invoiceNumberKey: num }), { numberRule: true }),
    ).toMatchObject({
      duplicate: false,
      number_match: { id: first, status: "decided", outcome_status: "refused_by_code" },
    });
    // Without the rule it is a duplicate at intake, and so is another rendering of the first text.
    expect(await insertInvoice(db, a, invoice({ invoiceNumberKey: num }))).toEqual({
      id: first,
      duplicate: true,
      status: "decided",
    });
    const fp = (
      await pg.query<{ f: string }>("select fingerprint_sha256 f from invoices where id = $1", [
        first,
      ])
    ).rows[0]?.f;
    expect(await insertInvoice(db, a, invoice({ fingerprint: fp }))).toEqual({
      id: first,
      duplicate: true,
      status: "decided",
    });
  });

  it.each([
    ["refused_by_code", "invoice.duplicate", true],
    ["refused_by_code", "ledger.unresolved", true],
    ["refused_by_contract", "DuplicateInvoice", true],
    ["refused_by_contract", "DuplicateRef", true],
    ["refused_by_code", "mandate.over_total", false],
    ["refused_by_code", "custom.invoice_number_duplicate", false],
    ["refused_by_contract", "OverMandateTotal", false],
    ["failed", "TxFailed", false],
  ])("a decided %s %s blocks the number and the text: %s", async (status, code, blocks) => {
    const num = key();
    const fp = key();
    const { id } = await insertInvoice(db, a, invoice({ invoiceNumberKey: num, fingerprint: fp }));
    await refuse(a, id, status, code);
    expect(
      await insertInvoice(db, a, invoice({ invoiceNumberKey: num }), { numberRule: true }),
    ).toMatchObject({
      duplicate: false,
      number_match: blocks ? { id, status: "decided", outcome_status: status } : null,
    });
    expect((await insertInvoice(db, a, invoice({ fingerprint: fp }))).duplicate).toBe(blocks);
  });

  // The outcome's code is the first refusing rule, and decide() runs the vault, mandate and limit rules before
  // invoice.duplicate: the decision entry lists the refusal the code hides.
  it("blocks a refusal whose decision entry refused invoice.duplicate or ledger.unresolved under another code", async () => {
    const cases = [
      [
        [
          { id: "mandate.uses_exhausted", outcome: "refuse" },
          { id: "invoice.duplicate", outcome: "refuse" },
        ],
        true,
      ],
      [
        [
          { id: "vault.frozen", outcome: "refuse" },
          { id: "ledger.unresolved", outcome: "refuse" },
        ],
        true,
      ],
      [
        [
          { id: "mandate.uses_exhausted", outcome: "refuse" },
          { id: "invoice.duplicate", outcome: "pass" },
        ],
        false,
      ],
    ] as const;
    for (const [rules, blocks] of cases) {
      const num = key();
      const { id } = await insertInvoice(db, a, invoice({ invoiceNumberKey: num }));
      await refuse(a, id, "refused_by_code", rules[0].id, await decisionEntry([...rules]));
      expect(
        (await insertInvoice(db, a, invoice({ invoiceNumberKey: num }))).duplicate,
        JSON.stringify(rules),
      ).toBe(blocks);
    }
    // Another tenant's entry with the same hash says nothing about this row.
    const hash = await decisionEntry([{ id: "invoice.duplicate", outcome: "refuse" }]);
    const num = key();
    const { id } = await insertInvoice(db, b, invoice({ invoiceNumberKey: num }));
    await refuse(b, id, "refused_by_code", "mandate.uses_exhausted", hash);
    expect((await insertInvoice(db, b, invoice({ invoiceNumberKey: num }))).duplicate).toBe(false);
  });

  // The extension queues without the tenant lease (0015), so a waiting row and a paid one can share a number. The
  // guard names the paid one: a notice that offered a re-upload after a Reject of the waiting one would answer 409.
  it("names an invoice that may have paid before an older one that waits for the owner", async () => {
    const num = key();
    const fp = key();
    const older = await awaiting({ invoiceNumberKey: num, fingerprint: fp });
    const { id: paid } = await insertInvoice(db, a, invoice());
    await decide(a, paid, "paid");
    await pg.query(
      "update invoices set invoice_number_hmac = $2, fingerprint_sha256 = $3 where id = $1",
      [paid, num, fp],
    );
    await pg.query("update invoices set created_at = now() - interval '1 hour' where id = $1", [
      older,
    ]);
    expect(
      await insertInvoice(db, a, invoice({ invoiceNumberKey: num }), { numberRule: true }),
    ).toMatchObject({ duplicate: false, number_match: { id: paid, status: "decided" } });
    expect(await insertInvoice(db, a, invoice({ invoiceNumberKey: num }))).toEqual({
      id: paid,
      duplicate: true,
      status: "decided",
    });
    expect(await insertInvoice(db, a, invoice({ fingerprint: fp }))).toEqual({
      id: paid,
      duplicate: true,
      status: "decided",
    });
    // With no row that may have paid, the oldest waiting one is named, as before.
    const num2 = key();
    const first = await awaiting({ invoiceNumberKey: num2 });
    const second = await awaiting({});
    await pg.query("update invoices set invoice_number_hmac = $2 where id = $1", [second, num2]);
    expect(await insertInvoice(db, a, invoice({ invoiceNumberKey: num2 }))).toEqual({
      id: first,
      duplicate: true,
      status: "awaiting_owner",
    });
  });

  it("still frees the number when the owner rejects the waiting invoice: the refused text runs again", async () => {
    const num = key();
    const first = await awaiting({ invoiceNumberKey: num });
    const second = invoice({ invoiceNumberKey: num });
    const { id } = await insertInvoice(db, a, second, { numberRule: true });
    await refuse(a, id, "refused_by_code", "custom.invoice_number_duplicate");
    const row = await getInvoice(db, a, first);
    expect(
      await setInvoiceRejected(db, a, first, "alice.near", {
        suggestedAmount: "5",
        invoiceHash: row?.invoice_hash ?? "",
        mandateId: null,
      }),
    ).toEqual({ changed: true, status: "rejected" });
    expect(await insertInvoice(db, a, second, { numberRule: true })).toEqual({
      id,
      duplicate: false,
      retry: true,
      number_match: null,
    });
  });

  // The extension queues without the tenant lease (0015), so two invoices with the number can both wait. The refused
  // text runs again only once the owner rejected each of them, as the notice says.
  it("frees the number only once the owner rejected every waiting invoice that has it", async () => {
    const num = key();
    const first = await awaiting({ invoiceNumberKey: num });
    const twin = await awaiting({});
    await pg.query("update invoices set invoice_number_hmac = $2 where id = $1", [twin, num]);
    const text = invoice({ invoiceNumberKey: num });
    const refused = await insertInvoice(db, a, text, { numberRule: true });
    expect(refused).toMatchObject({ number_match: { id: first, status: "awaiting_owner" } });
    await refuse(a, refused.id, "refused_by_code", "custom.invoice_number_duplicate");
    const reject = async (id: string) => {
      const row = await getInvoice(db, a, id);
      expect(
        await setInvoiceRejected(db, a, id, "alice.near", {
          suggestedAmount: "5",
          invoiceHash: row?.invoice_hash ?? "",
          mandateId: null,
        }),
      ).toEqual({ changed: true, status: "rejected" });
    };
    await reject(first);
    expect(await insertInvoice(db, a, text, { numberRule: true })).toEqual({
      id: refused.id,
      duplicate: true,
      status: "decided",
    });
    await reject(twin);
    expect(await insertInvoice(db, a, text, { numberRule: true })).toEqual({
      id: refused.id,
      duplicate: false,
      retry: true,
      number_match: null,
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
    // The table holds the same rule: a waiting row always has its suggestion. Since migration 0007 the snapshot
    // trigger refuses the change first (a waiting row keeps its suggestion); the check still refuses a row written
    // as waiting without one.
    await expect(
      pg.query("update invoices set suggested_amount = null where id = $1", [id]),
    ).rejects.toThrow(/invoice_snapshot_frozen/);
    await expect(
      pg.query(
        `insert into invoices (tenant_id, invoice_hash, ref, media_type, retained, status, request_id, created_by)
         values ($1, $2, 'inv-awaiting-no-amount', 'text/plain', false, 'awaiting_owner', 'r', 'x')`,
        [a, H("9")],
      ),
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
