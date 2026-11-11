// The payments CSV of /proof/<vault>/payments.csv: RFC 4180 text a spreadsheet opens as it is (a BOM, CRLF, quoting),
// with no field it could run as a formula, and one row per decision in each state the Decisions cards show, read from
// the same `decisionOutcome` the cards read.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks, type Snapshot } from "@probarion/core";
import { describe, expect, it } from "vitest";
import fixture from "@/lib/site/valid-snapshot.json";
import { type DecisionRow, decisionOutcome, decisionRows, type ShownPayment } from "./decisions";
import {
  CSV_BOM,
  csvField,
  csvRecord,
  guardFormula,
  NO_PAYMENT_ENTRY,
  NO_SPEND,
  PAYMENTS_COLUMNS,
  paymentFields,
  paymentsCsv,
  paymentsCsvFileName,
  paymentsCsvResponse,
  paymentsHeader,
} from "./payments-csv";
import type { ProofOk } from "./service";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "..");
const demo = JSON.parse(
  readFileSync(join(ROOT, "docs", "evidence", "demo-vault", "snapshot-2026-11-09.json"), "utf8"),
) as Snapshot;
const attested = fixture as unknown as Snapshot;
const TX = "https://testnet.nearblocks.io/txns/";

const rowAt = (rows: DecisionRow[], seq: number): DecisionRow => {
  const r = rows.find((x) => x.seq === seq);
  if (!r) throw new Error(`no decision at seq ${seq}`);
  return r;
};

/** A field of a row by its column, before quoting and the guard. */
function field(r: DecisionRow, column: (typeof PAYMENTS_COLUMNS)[number]): string {
  return paymentFields(r)[PAYMENTS_COLUMNS.indexOf(column)] ?? "";
}

const payment = (over: Partial<ShownPayment>): ShownPayment => ({
  seq: 5,
  at: "2026-11-10T16:02:00.000Z",
  status: "refused",
  code: "OverPerPayment",
  spendId: null,
  txHash: null,
  txUrl: null,
  txLabel: "no tx recorded",
  ...over,
});

/** `base` with its contract part replaced: the payment entries and the spends the chain binds to it. */
function withContract(
  base: DecisionRow,
  payments: ShownPayment[],
  spends: DecisionRow["checked"]["spends"] = [],
  verdict: DecisionRow["verdict"] = "allow",
): DecisionRow {
  return {
    ...base,
    verdict,
    spendIds: spends.map((s) => s.anchorId),
    checked: { ...base.checked, verdict, firstBlocking: null, payments, spends },
  };
}

describe("RFC 4180 fields and records", () => {
  it("quotes a field that holds a comma, a quote, a CR or an LF, and doubles its quotes", () => {
    expect(csvField("plain text")).toBe("plain text");
    expect(csvField("")).toBe("");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('"')).toBe('""""');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
    expect(csvField("car\rriage")).toBe('"car\rriage"');
    expect(csvField("a\r\nb")).toBe('"a\r\nb"');
  });

  it("ends each record with CRLF", () => {
    expect(csvRecord(["a", "b,c", ""])).toBe('a,"b,c",\r\n');
    expect(csvRecord([])).toBe("\r\n");
  });

  it("starts the file with a UTF-8 BOM, then the header row, every line ended by CRLF", async () => {
    const text = paymentsCsv(await decisionRows(demo, "testnet"), demo.taken_at);
    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect([...new TextEncoder().encode(text).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe(paymentsHeader(demo.taken_at).join(","));
    // The header, five decisions, and the empty string after the last CRLF: no preamble, no comment row.
    expect(lines).toHaveLength(7);
    expect(lines.at(-1)).toBe("");
  });

  it("is only the header for a vault with no decision yet", () => {
    expect(paymentsCsv([], "2026-11-09T11:58:06.558Z")).toBe(
      `${CSV_BOM}${paymentsHeader("2026-11-09T11:58:06.558Z").join(",")}\r\n`,
    );
  });
});

describe("the formula guard", () => {
  it("puts an apostrophe before a field that starts with = + - @, a tab or a CR", () => {
    for (const c of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(guardFormula(`${c}SUM(A1:A9)`), JSON.stringify(c)).toBe(`'${c}SUM(A1:A9)`);
    }
    expect(guardFormula("=")).toBe("'=");
  });

  it("leaves any other start alone, the trigger characters inside a field included", () => {
    for (const s of ["SUM(A1)", "a=b", "2026-11-09 11:53:32", "4", " =1", "'=1", "\n=1", ""]) {
      expect(guardFormula(s), JSON.stringify(s)).toBe(s);
    }
  });

  it("runs before the quoting, so a guarded field is still quoted when it needs to be", () => {
    expect(csvField('=HYPERLINK("https://x.test","pay")')).toBe(
      '"\'=HYPERLINK(""https://x.test"",""pay"")"',
    );
    expect(csvField("\r=1")).toBe('"\'\r=1"');
    expect(csvField("\t-1")).toBe("'\t-1");
    expect(csvField("-1,5")).toBe('"\'-1,5"');
  });

  it("guards a crafted label, payee and rule detail from the ledger and the chain", async () => {
    const s = structuredClone(demo) as unknown as {
      ledger: { body: { rules: { id: string; detail: string }[] } }[];
      chain: {
        mandates: { label: string; payee: { account_id: string } }[];
        spends: { destination: { account_id: string } }[];
      };
    };
    const mandate = s.chain.mandates[0];
    const spend = s.chain.spends[1];
    const rule = s.ledger[3]?.body.rules.find((r) => r.id === "mandate.payee_mismatch");
    if (!mandate || !spend || !rule) throw new Error("demo changed");
    mandate.label = '=HYPERLINK("https://evil.test","Pay")';
    spend.destination.account_id = "@SUM(1+1)";
    mandate.payee.account_id = "+cmd";
    const rows = await decisionRows(s as unknown as Snapshot, "testnet");
    const csv = paymentsCsv(rows, demo.taken_at);
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.test"",""Pay"")"`);
    // Seq 5's spend is on chain: its destination is the payee. Seq 3 has none: the mandate's payee is.
    expect(field(rowAt(rows, 5), "Payee")).toBe("@SUM(1+1)");
    expect(csv).toContain(",'@SUM(1+1),");
    expect(field(rowAt(rows, 3), "Payee")).toBe("+cmd");
    expect(csv).toContain(",'+cmd,");
    // No field of the file starts a formula: every field after a comma or a line start is checked.
    for (const line of csv.slice(1).split("\r\n")) {
      for (const f of line.split(",")) expect(f, line).not.toMatch(/^"?[=+\-@\t\r]/);
    }
  });
});

describe("one row per decision, in each state the cards show", () => {
  it("writes the columns in order, newest decision first, as the cards list them", async () => {
    expect(paymentsHeader("2026-11-09T11:58:06.558Z")).toEqual([
      "Date (UTC)",
      "Mandate",
      "Label",
      "Payee",
      "Amount (USDC)",
      "Decision",
      "Reason",
      "Spend id",
      "Status now (chain read 2026-11-09 11:58:06 UTC)",
      "Transaction",
      "Explorer link",
      "Invoice SHA-256",
      "Ledger seq",
    ]);
    const rows = await decisionRows(attested, "testnet");
    expect(rows.map((r) => field(r, "Ledger seq"))).toEqual(["4", "2", "0"]);
  });

  it("paid: the spend on chain, its tx and explorer link, the amount as a plain decimal", async () => {
    const r = rowAt(await decisionRows(attested, "testnet"), 0);
    expect(decisionOutcome(r).kind).toBe("spend");
    expect(paymentFields(r)).toEqual([
      "2026-11-05 10:00:00",
      "1",
      "TEST FIXTURE mandate 1 (NEAR vendor)",
      "vendor.fixture.testnet",
      "25",
      "allow",
      "",
      "1",
      "paid",
      "Afyz99fesbMSdpHXc5Fc6bqhsaPJ8Wrc7gc8JgBicCsT",
      `${TX}Afyz99fesbMSdpHXc5Fc6bqhsaPJ8Wrc7gc8JgBicCsT`,
      r.invoiceHash,
      "0",
    ]);
  });

  it("burned: an Intents payee as chain:address, and the spend's status on chain", async () => {
    const r = rowAt(await decisionRows(attested, "testnet"), 2);
    expect(field(r, "Payee")).toBe("base:0x1111111111111111111111111111111111111111");
    expect(field(r, "Amount (USDC)")).toBe("40");
    expect(field(r, "Decision")).toBe("allow");
    expect(field(r, "Spend id")).toBe("2");
    expect(field(r, "Status now")).toBe("burned");
    expect(field(r, "Transaction")).toBe("4UViDBu8eHvNMe7WB24hDfDA5un4R5Wmy7ENLWGeRecF");
  });

  it("held by the contract: the status on chain now, not the payment entry's held", async () => {
    // Demo seq 5 (INV-2003): the contract held spend 2 above the approval limit, and the approver paid it.
    const r = rowAt(await decisionRows(demo, "testnet"), 5);
    expect(r.checked.payments.map((p) => p.status)).toEqual(["held"]);
    expect(field(r, "Status now")).toBe("paid");
    expect(field(r, "Reason")).toBe(
      "above the mandate's approval limit, the contract held it for an approver (payment entry at seq 6)",
    );
    // Still held on chain: the status says so.
    const still = withContract(r, r.checked.payments, [
      { ...(r.checked.spends[0] as DecisionRow["checked"]["spends"][number]), status: "held" },
    ]);
    expect(field(still, "Status now")).toBe("held");
  });

  it("held by the code: the rule and its detail, nothing sent, no spend", async () => {
    const r = rowAt(await decisionRows(demo, "testnet"), 0);
    expect(decisionOutcome(r)).toMatchObject({ kind: "code", did: "held" });
    expect(field(r, "Decision")).toBe("hold");
    expect(field(r, "Reason")).toBe(
      "held by custom.owner_confirms_without_model, nothing sent: no model read this invoice: nothing is sent; the owner confirms the amount",
    );
    expect(field(r, "Spend id")).toBe("");
    expect(field(r, "Status now")).toBe(NO_SPEND);
    expect(field(r, "Transaction")).toBe("");
    expect(field(r, "Explorer link")).toBe("");
  });

  it("refused by the code: the rule that refused, not an earlier one that only held", async () => {
    const r = rowAt(await decisionRows(demo, "testnet"), 3);
    expect(field(r, "Decision")).toBe("refuse");
    expect(field(r, "Reason")).toBe(
      "refused by mandate.payee_mismatch, nothing sent: invoice names NEAR account new-account.testnet; the mandate pays probarion-payee.testnet",
    );
    expect(field(r, "Status now")).toBe(NO_SPEND);
    // With no rule that refused, it says the code did.
    const bare = { ...r, checked: { ...r.checked, firstBlocking: null } };
    expect(field(bare, "Reason")).toBe("refused by the code, nothing sent");
  });

  it("refused by the contract: no verdict next to it, the contract's code, nothing paid", async () => {
    const base = rowAt(await decisionRows(attested, "testnet"), 2);
    const r = withContract(base, [payment({ status: "refused", code: "OverPerPayment" })]);
    expect(decisionOutcome(r)).toMatchObject({ kind: "contract_refused", dryRun: false });
    expect(field(r, "Decision")).toBe("refused by contract");
    expect(field(r, "Reason")).toBe("OverPerPayment, nothing paid");
    expect(field(r, "Status now")).toBe(NO_SPEND);
    const bare = withContract(base, [payment({ status: "refused", code: null })]);
    expect(field(bare, "Reason")).toBe("nothing paid");
  });

  it("refused by the contract's dry run (check_failed): a contract refusal, nothing sent", async () => {
    const base = rowAt(await decisionRows(attested, "testnet"), 2);
    const r = withContract(base, [payment({ status: "check_failed", code: "UsesExhausted" })]);
    expect(decisionOutcome(r)).toMatchObject({ kind: "contract_refused", dryRun: true });
    expect(field(r, "Decision")).toBe("refused by contract");
    expect(field(r, "Reason")).toBe("UsesExhausted in the contract's dry run, nothing sent");
    const bare = withContract(base, [payment({ status: "check_failed", code: null })]);
    expect(field(bare, "Reason")).toBe("refused in the contract's dry run, nothing sent");
  });

  it("no payment entry and no spend: the card's sentence, and no spend", async () => {
    const base = rowAt(await decisionRows(attested, "testnet"), 0);
    const r = withContract(base, []);
    expect(decisionOutcome(r).kind).toBe("none");
    expect(field(r, "Decision")).toBe("allow");
    expect(field(r, "Reason")).toBe(NO_PAYMENT_ENTRY);
    expect(field(r, "Spend id")).toBe("");
    expect(field(r, "Status now")).toBe(NO_SPEND);
    expect(field(r, "Transaction")).toBe("");
  });

  it("a payment entry with no spend on chain: what the entry says, and that the chain holds none", async () => {
    const base = rowAt(await decisionRows(attested, "testnet"), 0);
    const hash = "Afyz99fesbMSdpHXc5Fc6bqhsaPJ8Wrc7gc8JgBicCsT";
    const r = withContract(base, [
      payment({
        seq: 1,
        status: "paid",
        code: null,
        spendId: "1",
        txHash: hash,
        txUrl: `${TX}${hash}`,
      }),
    ]);
    expect(decisionOutcome(r).kind).toBe("payment");
    expect(field(r, "Reason")).toBe(
      "the payment entry at seq 1 says paid for spend 1, and the chain holds no spend for this decision",
    );
    expect(field(r, "Status now")).toBe(NO_SPEND);
    expect(field(r, "Transaction")).toBe(hash);
    expect(field(r, "Explorer link")).toBe(`${TX}${hash}`);
  });

  it("lists every spend the chain binds to one decision, and each tx once", async () => {
    const base = rowAt(await decisionRows(attested, "testnet"), 0);
    const [spend] = base.checked.spends;
    const [p] = base.checked.payments;
    if (!spend || !p) throw new Error("fixture changed");
    const r = withContract(
      base,
      [p, { ...p, seq: 7 }],
      [
        { ...spend, status: "expired" },
        { ...spend, id: 9, anchorId: "spend-9" },
      ],
    );
    expect(field(r, "Spend id")).toBe("1; 9");
    expect(field(r, "Status now")).toBe("expired; paid");
    expect(field(r, "Transaction")).toBe(p.txHash);
  });

  it("writes an amount with no USDC units as empty, and a crafted one as the ledger has it", async () => {
    const base = rowAt(await decisionRows(attested, "testnet"), 0);
    expect(
      field({ ...base, amount: { units: "2500001", text: "2.500001 USDC" } }, "Amount (USDC)"),
    ).toBe("2.500001");
    expect(field({ ...base, amount: { units: "1000000000000", text: "" } }, "Amount (USDC)")).toBe(
      "1000000",
    );
    expect(field({ ...base, amount: { units: null, text: "none" } }, "Amount (USDC)")).toBe("");
    expect(
      field({ ...base, amount: { units: null, text: "-5 (not a USDC amount)" } }, "Amount (USDC)"),
    ).toBe("-5 (not a USDC amount)");
    expect(csvField("-5 (not a USDC amount)")).toBe("'-5 (not a USDC amount)");
    expect(field({ ...base, mandateId: null }, "Mandate")).toBe("");
  });

  it("writes a time it cannot read as the ledger has it", async () => {
    const base = rowAt(await decisionRows(attested, "testnet"), 0);
    expect(field({ ...base, at: "not a time" }, "Date (UTC)")).toBe("not a time");
    expect(paymentsHeader("soon")[8]).toBe("Status now (chain read soon)");
  });
});

describe("the download", () => {
  const ok = async (audience: ProofOk["audience"]): Promise<ProofOk> => ({
    status: "ok",
    vault: demo.vault,
    network: "testnet",
    kind: "team",
    audience,
    snapshot: demo,
    report: await runChecks(demo),
  });

  it("names the file after the vault and the UTC time its snapshot was taken, with no colon", () => {
    expect(paymentsCsvFileName("acme.vaults.probarion.near", "2026-11-09T11:58:06.558Z")).toBe(
      "acme.vaults.probarion.near-payments-20261109T115806Z.csv",
    );
    expect(paymentsCsvFileName("acme.near", "2026-11-09T13:58:06+02:00")).toBe(
      "acme.near-payments-20261109T115806Z.csv",
    );
    expect(paymentsCsvFileName("acme.near", "unreadable")).toBe("acme.near-payments.csv");
    expect(paymentsCsvFileName("acme.near", null)).toBe("acme.near-payments.csv");
  });

  it("is text/csv in UTF-8, an attachment, and not reused by a browser; a member's view is not stored", async () => {
    const rows = await decisionRows(demo, "testnet");
    const res = paymentsCsvResponse(await ok("public"), rows);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="demo.vaults.probarion.testnet-payments-20261109T115806Z.csv"`,
    );
    expect(res.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    const body = new Uint8Array(await res.arrayBuffer());
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(body)).toBe(
      paymentsCsv(rows, demo.taken_at),
    );
    const member = paymentsCsvResponse(await ok("member"), rows);
    expect(member.headers.get("cache-control")).toBe("private, no-store");
  });
});
