import type { LedgerEntry, MandateView } from "@probarion/core";
import type { SpendOutcome } from "@probarion/sdk";
import { describe, expect, it } from "vitest";
import { txHash } from "../../../test/fixtures/proof";
import { AMOUNT_ISSUES } from "./amount";
import { utcMinute } from "./forms";
import { OWNER_CONFIRMS_RULE } from "./owner-confirms";
import type { InvoiceRow } from "./store";
import {
  ATTESTATION_LABEL,
  amountIssueText,
  amountMatch,
  buildCycleView,
  invoiceStatusLabel,
  outcomeLabel,
  queuedChecks,
  recentPayeeRows,
  rowResult,
  usdcFixed,
  waitReasons,
} from "./view";

// The Payables view (plan 04 Task 14): what the model wanted, what the code allowed and what the contract did,
// built from the signed ledger and the invoice row, with every attacker-influenced string made safe to show.

/** True when the text still holds a right-to-left override, a line break, a line separator or a BEL. */
const hasUnsafe = (text: string): boolean =>
  [...text].some((c) => [0x202e, 0x0a, 0x2028, 0x07].includes(c.codePointAt(0) ?? -1));

const ANCHOR = txHash(5);
const FAIL = txHash(6);
const PAID = txHash(7);

const decision = (over: Partial<LedgerEntry["body"]> = {}): LedgerEntry =>
  ({
    body: {
      v: 1,
      vault: "v.near",
      seq: 4,
      prev_link: "0".repeat(64),
      kind: "decision",
      at: "2026-11-08T10:00:00Z",
      request_id: "r",
      mandate_id: 1,
      invoice_hash: "a".repeat(64),
      amount: "300000000",
      proposal: {
        action: "pay",
        mandate_id: 1,
        amount: "300000000",
        payee_hint: { chain: "base", address: "0xBAD0000000000000000000000000000000000001" },
        reasoning: "Vendor changed accounts",
        confidence: 0.92,
      },
      evidence: {
        provider: "near-ai-cloud",
        model: "m-1",
        chat_id: "chat-9",
        signature: { signing_address: "0xabc" },
      },
      rules: [
        { id: "mandate.none", outcome: "pass", detail: "mandate 1" },
        {
          id: "mandate.payee_mismatch",
          outcome: "refuse",
          detail: "invoice asks for 0xBAD…, mandate pays 0x5290…",
        },
      ],
      verdict: "refuse",
      decided_by: "model+rules",
      contract: null,
      settlement: null,
      refs: null,
      ...over,
    },
    body_hash: "d".repeat(64),
    sig: "ed25519:x",
    signer: "ed25519:y",
    link: "1".repeat(64),
  }) as unknown as LedgerEntry;

/** A ledger `anchor` entry: R20 says there are none, and the view never reads one. */
const anchorEntry = {
  body: {
    kind: "anchor",
    seq: 5,
    contract: { code: null, tx_hash: txHash(9), spend_id: null, status: "ok" },
  },
  body_hash: "f".repeat(64),
} as unknown as LedgerEntry;

const outcome = (over: Partial<SpendOutcome> = {}): SpendOutcome => ({
  status: "refused_by_code",
  spendId: null,
  code: null,
  txHash: null,
  ledgerSeq: 4,
  decisionHash: "d".repeat(64),
  anchorTxHash: null,
  ...over,
});

describe("buildCycleView", () => {
  it("shows what the model wanted, which rule refused, and that nothing was sent", () => {
    const v = buildCycleView([decision(), anchorEntry], outcome(), "mainnet", ANCHOR);
    expect(v.found).toBe(true);
    expect(v.modelWanted).toMatchObject({
      action: "pay",
      amount: "300000000",
      payeeHint: "base:0xBAD0000000000000000000000000000000000001",
      confidence: 0.92,
    });
    expect(v.codeAllowed.verdict).toBe("refuse");
    expect(v.codeAllowed.firstBlocking?.id).toBe("mandate.payee_mismatch");
    expect(v.contractDid).toMatchObject({
      status: "refused_by_code",
      txUrl: null,
      label: "Not sent: code refused it",
    });
    expect(v.attestation).toMatchObject({
      state: "attested",
      model: "m-1",
      chatId: "chat-9",
      signingAddress: "0xabc",
      label: "Attested (checks A1–A7 passed)",
    });
    // R20: the anchor link comes from the invoice row, never from a ledger entry.
    expect(v.anchorTxUrl).toBe(`https://nearblocks.io/txns/${ANCHOR}`);
    expect(v.decisionHash).toBe("d".repeat(64));
  });

  it("takes no anchor from a ledger entry, and links only a well-formed tx hash", () => {
    expect(buildCycleView([decision(), anchorEntry], outcome(), "mainnet").anchorTxUrl).toBeNull();
    expect(buildCycleView([decision()], outcome(), "mainnet", "ANCHORTX").anchorTxUrl).toBeNull();
    const bad = buildCycleView(
      [decision()],
      outcome({ status: "refused_by_contract", code: "NoMandate", txHash: "not a hash" }),
      "mainnet",
    );
    expect(bad.contractDid.txUrl).toBeNull();
  });

  it("links a contract refusal on the network's explorer and labels rules-only decisions", () => {
    const v = buildCycleView(
      [decision({ evidence: null, decided_by: "rules-only", proposal: null })],
      outcome({ status: "refused_by_contract", code: "NoMandate", txHash: FAIL }),
      "testnet",
    );
    expect(v.modelWanted).toBeNull();
    expect(v.attestation).toMatchObject({ state: "rules-only", label: "Rules only (no model)" });
    expect(v.contractDid).toMatchObject({
      label: "Contract refused: NoMandate",
      txUrl: `https://testnet.nearblocks.io/txns/${FAIL}`,
    });
  });

  it("says no attestation when a model decision carries no evidence, or the decision is missing", () => {
    const v = buildCycleView([decision({ evidence: null })], outcome(), "mainnet");
    expect(v.attestation).toMatchObject({ state: "missing", label: "No attestation" });
    const gone = buildCycleView([], outcome(), "mainnet");
    expect(gone.found).toBe(false);
    expect(gone.attestation.state).toBe("missing");
    expect(gone.codeAllowed).toMatchObject({ verdict: null, rules: [], firstBlocking: null });
    expect(gone.modelWanted).toBeNull();
  });

  it("shows a spend the contract paid, with its id and transaction", () => {
    const v = buildCycleView(
      [
        decision({
          verdict: "allow",
          rules: [{ id: "mandate.none", outcome: "pass", detail: "" }],
        }),
      ],
      outcome({ status: "paid", spendId: 3, txHash: PAID }),
      "mainnet",
    );
    expect(v.contractDid).toMatchObject({ spendId: 3, label: "Paid on NEAR" });
    expect(v.contractDid.txUrl).toContain(PAID);
    expect(v.codeAllowed.firstBlocking).toBeNull();
  });

  it("makes every attacker-influenced string safe to show", () => {
    const evil = `pay\u202Etoday\nnow\u2028${"x".repeat(5000)}\u0007`;
    const v = buildCycleView(
      [
        decision({
          proposal: {
            action: "pay",
            mandate_id: 1,
            amount: "1",
            payee_hint: { name: evil },
            reasoning: evil,
            confidence: 0.9,
          },
          evidence: {
            model: evil,
            chat_id: evil,
            signature: { signing_address: evil },
          } as never,
          rules: [{ id: `custom.${evil}` as never, outcome: "hold", detail: evil }],
        }),
      ],
      outcome({ status: "refused_by_contract", code: evil }),
      "mainnet",
    );
    const shown = [
      v.modelWanted?.reasoning,
      v.modelWanted?.payeeHint,
      v.attestation.model,
      v.attestation.chatId,
      v.attestation.signingAddress,
      v.codeAllowed.rules[0]?.id,
      v.codeAllowed.rules[0]?.detail,
      v.codeAllowed.firstBlocking?.detail,
      v.contractDid.code,
      v.contractDid.label,
    ];
    for (const s of shown) {
      expect(typeof s).toBe("string");
      expect(hasUnsafe(s as string), String(s)).toBe(false);
      expect((s as string).length).toBeLessThan(2100);
    }
  });

  it("shows a verdict, a decider or a rule outcome it does not know as unknown", () => {
    const v = buildCycleView(
      [
        decision({
          verdict: "<b>allow</b>" as never,
          decided_by: "the\u202Eowner" as never,
          rules: [{ id: "mandate.none", outcome: "maybe" as never, detail: "x" }],
        }),
      ],
      outcome(),
      "mainnet",
    );
    expect(v.codeAllowed.verdict).toBe("unknown");
    expect(v.codeAllowed.decidedBy).toBe("unknown");
    expect(v.codeAllowed.rules[0]?.outcome).toBe("unknown");
    const known = buildCycleView([decision()], outcome(), "mainnet");
    expect(known.codeAllowed).toMatchObject({ verdict: "refuse", decidedBy: "model+rules" });
    expect(known.codeAllowed.rules.map((r) => r.outcome)).toEqual(["pass", "refuse"]);
  });

  it("reads a NaN or missing confidence as 0 rather than throwing", () => {
    const v = buildCycleView(
      [
        decision({
          proposal: {
            action: "hold",
            mandate_id: null,
            amount: null,
            payee_hint: null,
            reasoning: "",
            confidence: Number.NaN,
          },
        }),
      ],
      outcome({ status: "held" }),
      "mainnet",
    );
    expect(v.modelWanted).toMatchObject({ confidence: 0, payeeHint: null, amount: null });
  });
});

describe("outcomeLabel", () => {
  it("labels every outcome status", () => {
    expect(outcomeLabel("refused_by_code", null)).toBe("Not sent: code refused it");
    expect(outcomeLabel("refused_by_contract", null)).toBe("Contract refused: unknown code");
    expect(outcomeLabel("held", null)).toBe("Held for approval");
    expect(outcomeLabel("held", OWNER_CONFIRMS_RULE, null)).toBe("Held by code: nothing was sent");
    expect(outcomeLabel("held", null, 4)).toBe("Held for approval");
    expect(outcomeLabel("paid", null)).toBe("Paid on NEAR");
    expect(outcomeLabel("burned", null)).toMatch(/Base/);
    expect(outcomeLabel("settled", null)).toMatch(/Settled/);
    expect(outcomeLabel("failed", null)).toMatch(/released/);
    expect(outcomeLabel("unconfirmed", null)).toBe(
      "Payment sent, confirmation pending: do not resend",
    );
  });

  it("shows a status it does not know as unknown, without throwing", () => {
    expect(outcomeLabel("teleported" as never, null)).toMatch(/^Unknown outcome/);
    expect(hasUnsafe(outcomeLabel("x\u202Ey" as never, null))).toBe(false);
  });
});

describe("invoiceStatusLabel", () => {
  it("names every invoice status, the owner's and everyone else's wording", () => {
    expect(invoiceStatusLabel("received")).toBe("Received");
    expect(invoiceStatusLabel("processing")).toBe("Outcome unknown: do not resend");
    expect(invoiceStatusLabel("decided")).toBe("Decided");
    expect(invoiceStatusLabel("unconfirmed")).toBe(
      "Payment sent, confirmation pending: do not resend",
    );
    expect(invoiceStatusLabel("awaiting_owner")).toBe(
      "Waiting for you: no attested model confirmed the amount",
    );
    expect(invoiceStatusLabel("awaiting_owner", false)).toBe(
      "Waiting for the owner: no attested model confirmed the amount",
    );
    expect(invoiceStatusLabel("error")).toMatch(/before any payment/);
    expect(invoiceStatusLabel("rejected")).toMatch(/^Rejected by the owner/);
    expect(invoiceStatusLabel("archived" as never)).toMatch(/^Unknown status/);
  });
});

describe("rowResult", () => {
  const row = (over: Partial<InvoiceRow>) =>
    ({ status: "decided", outcome: null, ...over }) as InvoiceRow;
  it("shows a decided row by its outcome, and any other row by its status", () => {
    expect(rowResult(row({ outcome: outcome({ status: "paid", spendId: 1 }) }))).toEqual({
      label: "Paid on NEAR",
      tone: "good",
    });
    expect(rowResult(row({ outcome: outcome({ status: "held", spendId: 2 }) })).tone).toBe("warn");
    expect(rowResult(row({ outcome: outcome() })).tone).toBe("bad");
    expect(rowResult(row({ status: "awaiting_owner" }), false)).toEqual({
      label: "Waiting for the owner: no attested model confirmed the amount",
      tone: "warn",
    });
    expect(rowResult(row({ status: "processing" })).tone).toBe("warn");
    expect(rowResult(row({ status: "error" })).tone).toBe("bad");
    expect(rowResult(row({ status: "rejected" })).tone).toBe("neutral");
  });
});

describe("an invoice from the browser extension", () => {
  const row = (over: Partial<InvoiceRow>) =>
    ({
      status: "awaiting_owner",
      outcome: null,
      source: "extension",
      queue_checks: null,
      ...over,
    }) as InvoiceRow;

  it("says where it came from while it waits, and a console row reads as before", () => {
    expect(rowResult(row({}))).toEqual({
      label: "Waiting for you: sent from the browser extension",
      tone: "warn",
    });
    expect(rowResult(row({}), false).label).toBe(
      "Waiting for the owner: sent from the browser extension",
    );
    expect(rowResult(row({ source: "console" }))).toEqual({
      label: "Waiting for you: no attested model confirmed the amount",
      tone: "warn",
    });
    expect(
      rowResult(row({ status: "decided", outcome: outcome({ status: "paid", spendId: 1 }) })),
    ).toEqual({ label: "Paid on NEAR", tone: "good" });
  });

  it("shows the checks it was queued with, made safe, and none for a console row", () => {
    const checks = [
      { id: "extension.mandate_chosen", outcome: "hold", detail: "chosen\u202E here" },
      { id: "contract.check_spend", outcome: "pass", detail: "ok" },
      { id: "x", outcome: "maybe", detail: "d" },
    ] as InvoiceRow["queue_checks"];
    const shown = queuedChecks(row({ queue_checks: checks }));
    expect(shown.map((c) => [c.id, c.outcome])).toEqual([
      ["extension.mandate_chosen", "hold"],
      ["contract.check_spend", "pass"],
      ["x", "unknown"],
    ]);
    expect(hasUnsafe(shown[0]?.detail ?? "")).toBe(false);
    expect(queuedChecks(row({ source: "console", queue_checks: checks }))).toEqual([]);
    expect(queuedChecks(row({ queue_checks: "nope" as never }))).toEqual([]);
    expect(queuedChecks(row({ queue_checks: [null, 7, ...(checks ?? [])] as never }))).toHaveLength(
      3,
    );
  });
});

describe("amountIssueText", () => {
  it("gives every reason a plain sentence and says the owner can pay it by hand", () => {
    const seen = new Set<string>();
    for (const issue of AMOUNT_ISSUES) {
      const text = amountIssueText(issue);
      expect(text, issue).toMatch(/by hand/);
      seen.add(text);
    }
    expect(seen.size).toBe(AMOUNT_ISSUES.length);
    expect(amountIssueText("not_found")).toMatch(/no final total/);
    expect(amountIssueText("currency")).toMatch(/USD/);
    expect(amountIssueText("truncated")).toMatch(/cut short/);
    expect(amountIssueText("zero")).toMatch(/zero/);
    expect(amountIssueText("whatever" as never)).toMatch(/by hand/);
  });
});

describe("usdcFixed", () => {
  it("writes base units with all six decimals, and anything else as unreadable", () => {
    expect(usdcFixed("20000000")).toBe("20.000000");
    expect(usdcFixed("1")).toBe("0.000001");
    expect(usdcFixed("123456789012")).toBe("123456.789012");
    expect(usdcFixed("0")).toBe("0.000000");
    for (const bad of ["", "-1", "1.5", "007", "1e6", " 1"])
      expect(usdcFixed(bad)).toBe("unreadable");
  });
});

describe("waitReasons", () => {
  it("returns the owner rule's detail and every rule that held or refused before it", () => {
    const entry = decision({
      verdict: "hold",
      rules: [
        { id: "mandate.none", outcome: "pass", detail: "mandate 2" },
        { id: "intents.balance_low", outcome: "hold", detail: "POA balance 0" },
        { id: OWNER_CONFIRMS_RULE, outcome: "hold", detail: "no model read this invoice: …" },
      ],
    });
    const r = waitReasons([entry], outcome({ status: "held", code: "intents.balance_low" }));
    expect(r.owner?.detail).toBe("no model read this invoice: …");
    expect(r.before.map((x) => x.id)).toEqual(["intents.balance_low"]);
    expect(waitReasons([], outcome())).toEqual({ owner: null, before: [] });
  });
});

describe("recentPayeeRows", () => {
  const NOW = new Date("2026-11-10T00:00:00Z");
  const mandate = (id: number, account: string): MandateView =>
    ({ id, payee: { type: "near", account_id: account } }) as unknown as MandateView;
  const mandates = [mandate(1, "vendor.near"), mandate(2, "Vendor.near"), mandate(3, "other.near")];
  const hash = (n: number) => n.toString(16).padStart(64, "0");
  const row = (n: number, over: Partial<InvoiceRow> = {}): InvoiceRow =>
    ({
      id: `id-${n}`,
      invoice_hash: hash(n),
      ref: `inv-${n}`,
      status: "decided",
      suggested_amount: null,
      mandate_id: null,
      outcome: null,
      created_by: "cfo.near",
      created_at: `2026-11-0${n}T00:00:00Z`,
      ...over,
    }) as InvoiceRow;
  /** The decision the ledger holds for invoice n: its mandate and amount. */
  const decided = (n: number, mandateId: number | null, amount: string | null, seq = n) =>
    decision({ seq, invoice_hash: hash(n), mandate_id: mandateId, amount });

  it("lists every recent invoice of the same payee, whatever its amount, marking equal and near amounts", () => {
    const target = row(9, {
      status: "awaiting_owner",
      suggested_amount: "20000000",
      mandate_id: 1,
    });
    const rows = [
      target,
      row(2, { status: "decided", outcome: { status: "paid" } as SpendOutcome }), // same payee, same amount
      row(3, { status: "awaiting_owner", suggested_amount: "20500000", mandate_id: 2 }), // +2.5%: same account
      row(4), // another amount, same payee
      row(5), // another payee
      row(6, { status: "error" }), // no mandate, no decision
      row(7, { status: "unconfirmed" }), // -5% exactly
      row(8, { created_at: "2026-08-01T00:00:00Z" }), // older than 90 days
    ];
    const entries = [
      decided(2, 1, "20000000"),
      decided(4, 1, "35000000"),
      decided(5, 3, "20000000"),
      decided(7, 1, "19000000"),
      decided(8, 1, "20000000"),
    ];
    const r = recentPayeeRows(target, rows, entries, mandates, NOW);
    expect(r.payee).toBe("near:vendor.near");
    expect(r.amount).toBe("20000000");
    expect(r.rows.map((x) => [x.id, x.match])).toEqual([
      ["id-7", "near"],
      ["id-4", null],
      ["id-3", "near"],
      ["id-2", "equal"],
    ]);
    expect(r.rows.map((x) => x.label)).toEqual([
      "Payment sent, confirmation pending: do not resend",
      "Decided",
      "Waiting for you: no attested model confirmed the amount",
      "Paid on NEAR",
    ]);
    expect(r.rows[0]).toMatchObject({ amount: "19000000", createdBy: "cfo.near" });
  });

  it("takes an invoice's mandate from its row first, then from its latest decision", () => {
    const target = row(1, { status: "awaiting_owner", suggested_amount: "5", mandate_id: 1 });
    // Invoice 2 was decided twice: first under mandate 3, then (later, higher seq) under mandate 1.
    const rows = [target, row(2), row(3, { mandate_id: 3 })];
    const entries = [decided(2, 3, "5", 10), decided(2, 1, "5", 11), decided(3, 1, "5")];
    expect(recentPayeeRows(target, rows, entries, mandates, NOW).rows.map((x) => x.id)).toEqual([
      "id-2",
    ]);
  });

  it("labels another waiting invoice of the payee that came from the browser extension as one", () => {
    const target = row(1, { status: "awaiting_owner", suggested_amount: "5", mandate_id: 1 });
    const fromExtension = row(2, {
      status: "awaiting_owner",
      suggested_amount: "5",
      mandate_id: 1,
      source: "extension",
    });
    const rows = [target, fromExtension, row(3, { status: "awaiting_owner", mandate_id: 1 })];
    expect(recentPayeeRows(target, rows, [], mandates, NOW).rows.map((x) => x.label)).toEqual([
      "Waiting for you: no attested model confirmed the amount",
      "Waiting for you: sent from the browser extension",
    ]);
    expect(
      recentPayeeRows(target, rows, [], mandates, NOW, false).rows.map((x) => x.label),
    ).toEqual([
      "Waiting for the owner: no attested model confirmed the amount",
      "Waiting for the owner: sent from the browser extension",
    ]);
  });

  it("says the payee is unknown when the waiting invoice's mandate is not on chain", () => {
    const target = row(1, { status: "awaiting_owner", suggested_amount: "5", mandate_id: 99 });
    const r = recentPayeeRows(target, [target, row(2)], [decided(2, 1, "5")], mandates, NOW);
    expect(r).toMatchObject({ payee: null, rows: [] });
  });
});

describe("amountMatch", () => {
  it("is equal, within 5% either way, or neither", () => {
    expect(amountMatch("100", "100")).toBe("equal");
    expect(amountMatch("105", "100")).toBe("near");
    expect(amountMatch("95", "100")).toBe("near");
    expect(amountMatch("106", "100")).toBeNull();
    expect(amountMatch("94", "100")).toBeNull();
    expect(amountMatch("20000001", "20000000")).toBe("near");
    expect(amountMatch(null, "100")).toBeNull();
    expect(amountMatch("1.5", "100")).toBeNull();
  });
});

describe("ATTESTATION_LABEL", () => {
  it("claims no TDX quote verification", () => {
    for (const label of Object.values(ATTESTATION_LABEL)) {
      expect(label).not.toMatch(/TDX|quote|TEE|hardware/i);
    }
  });
});

describe("utcMinute", () => {
  it("writes an ISO time to the minute in UTC, and anything else as safe text", () => {
    expect(utcMinute("2026-11-09T10:00:59.999+00:00")).toBe("2026-11-09 10:00 UTC");
    expect(utcMinute("2026-11-09T12:30:00+02:00")).toBe("2026-11-09 10:30 UTC");
    expect(hasUnsafe(utcMinute("not a time\u202E"))).toBe(false);
  });
});
