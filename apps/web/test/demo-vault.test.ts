// The testnet demo vault's evidence in docs/evidence/demo-vault: the site and the README point to it, so it has to hold
// up on its own. The verifier runs on the committed snapshot, and every file is tied to the chain data in it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks, type Snapshot } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { decisionRows } from "@/lib/proof/decisions";
import { paymentsCsv } from "@/lib/proof/payments-csv";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const EVIDENCE = join(ROOT, "docs", "evidence", "demo-vault");
const bytes = (name: string) => readFileSync(join(EVIDENCE, name));
const sha256 = (name: string) => createHash("sha256").update(bytes(name)).digest("hex");

const snapshot = JSON.parse(bytes("snapshot-2026-11-09.json").toString("utf8")) as Snapshot & {
  chain: {
    config: { owner: string; approvers: string[] };
    code_hash: string;
    access_keys: { public_key: string; permission: { method_names: string[] } | "FullAccess" }[];
    spends: { id: number; amount: string; invoice_hash: string; status: string }[];
    mandates: { id: number; purpose_hash: string; payee: { account_id: string } }[];
    anchors: unknown[];
  };
};
type Body = {
  seq: number;
  kind: string;
  invoice_hash: string;
  verdict: string;
  rules: { id: string; outcome: string }[];
};
const ledger = bytes("ledger-2026-11-09.jsonl")
  .toString("utf8")
  .trim()
  .split("\n")
  .map((line) => (JSON.parse(line) as { body: Body }).body);
const deployment = JSON.parse(
  readFileSync(join(ROOT, "contracts", "deployments", "testnet.json"), "utf8"),
) as {
  demo_vault: {
    account: string;
    owner: string;
    approvers: string[];
    payee: string;
    code_hash: string;
    agent_key: string;
    ledger_key: string;
    anchors: number;
    evidence: string;
    spends: {
      id: number;
      invoice: string;
      amount: string;
      spend_tx: string;
      approve_tx?: string;
    }[];
    refusals: { invoice: string; rule: string; ledger_seq: number }[];
    verify: { result: string; passed: number };
  };
};
const demo = deployment.demo_vault;

describe("the testnet demo vault's evidence", () => {
  it("passes checks a to i offline, on the snapshot its live run wrote", async () => {
    const report = await runChecks(snapshot);
    expect(report.vault).toBe("demo.vaults.probarion.testnet");
    expect(report.checks.map((c) => `${c.id} ${c.status}`)).toEqual(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) => `${id} pass`),
    );
    expect(report.ok).toBe(true);
  });

  it("keeps the live run's output, which passed the same nine checks", () => {
    const out = bytes("verify-2026-11-09.txt").toString("utf8");
    expect(out).toContain("Probarion verify: demo.vaults.probarion.testnet (testnet)");
    expect(out).toContain("9 passed, 0 failed, 0 unproven");
    expect(out).toContain("RESULT: PASS");
    expect(demo.verify).toMatchObject({ result: "PASS", passed: 9 });
  });

  it("is the vault the deployment record names, with its keys and roles as the chain has them", () => {
    expect(demo.account).toBe(snapshot.vault);
    expect(demo.evidence).toBe("docs/evidence/demo-vault");
    expect(snapshot.chain.code_hash).toBe(demo.code_hash);
    expect(snapshot.chain.config.owner).toBe(demo.owner);
    expect(snapshot.chain.config.approvers).toEqual(demo.approvers);
    expect(snapshot.chain.access_keys).toEqual([
      expect.objectContaining({
        public_key: demo.agent_key,
        permission: expect.objectContaining({ method_names: ["spend"] }),
      }),
      expect.objectContaining({
        public_key: demo.ledger_key,
        permission: expect.objectContaining({ method_names: ["anchor"] }),
      }),
    ]);
    expect(snapshot.chain.anchors).toHaveLength(demo.anchors);
  });

  it("signed its mandate on the PO in the folder, for the payee the record names", () => {
    const [mandate] = snapshot.chain.mandates;
    expect(mandate?.purpose_hash).toBe(sha256("po-PO-1001.txt"));
    expect(mandate?.payee.account_id).toBe(demo.payee);
  });

  it("paid the two invoices it records, each spend bound to the exact invoice file", () => {
    expect(demo.spends.map((s) => s.invoice)).toEqual(["INV-2001", "INV-2003"]);
    for (const recorded of demo.spends) {
      const onChain = snapshot.chain.spends.find((s) => s.id === recorded.id);
      expect(onChain?.invoice_hash, recorded.invoice).toBe(
        sha256(`invoice-${recorded.invoice}.txt`),
      );
      expect(onChain?.amount).toBe(recorded.amount);
      // Spend 2 was held above the approval limit; the approver's approve paid it.
      expect(onChain?.status).toBe("paid");
    }
  });

  it("refused the changed-bank invoice in the signed ledger, and sent nothing for it", () => {
    expect(demo.refusals).toEqual([
      { invoice: "INV-2002", rule: "mandate.payee_mismatch", ledger_seq: 3 },
    ]);
    const hash = sha256("invoice-INV-2002.txt");
    expect(bytes("invoice-INV-2002.txt").toString("utf8")).toContain("Payee: new-account.testnet");
    const entries = ledger.filter((e) => e.invoice_hash === hash);
    expect(entries.map((e) => [e.seq, e.kind, e.verdict])).toEqual([[3, "decision", "refuse"]]);
    expect(entries[0]?.rules).toContainEqual({
      id: "mandate.payee_mismatch",
      outcome: "refuse",
      detail:
        "invoice names NEAR account new-account.testnet; the mandate pays probarion-payee.testnet",
    });
    expect(snapshot.chain.spends.map((s) => s.invoice_hash)).not.toContain(hash);
  });

  it("serves the same ledger the snapshot holds", () => {
    expect(snapshot.ledger.map((e) => (e as { body: Body }).body.seq)).toEqual(
      ledger.map((e) => e.seq),
    );
    expect(ledger.map((e) => e.kind)).toEqual([
      "decision",
      "decision",
      "payment",
      "decision",
      "decision",
      "decision",
      "payment",
    ]);
  });
});

describe("the testnet demo vault's payments CSV", () => {
  const FILE = "payments-2026-11-09.csv";

  it("is the payments CSV of the committed snapshot, byte for byte", async () => {
    const csv = paymentsCsv(await decisionRows(snapshot, "testnet"), snapshot.taken_at);
    const path = join(EVIDENCE, FILE);
    // This test wrote the file. After a deliberate change to the CSV, delete it and run the test again (not on CI,
    // where a missing file fails).
    if (!existsSync(path) && !process.env.CI) writeFileSync(path, csv, "utf8");
    const committed = bytes(FILE);
    expect(committed.toString("utf8"), `${FILE} drifted from paymentsCsv`).toBe(csv);
    // .gitattributes keeps the CRLF line ends and the BOM as written: git does not convert the file.
    expect([...committed.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(committed.toString("utf8").split("\r\n")).toHaveLength(7);
    expect(committed.toString("utf8").replaceAll("\r\n", "")).not.toContain("\n");
    expect(readFileSync(join(ROOT, ".gitattributes"), "utf8")).toMatch(
      /^docs\/evidence\/demo-vault\/\*\.csv -text$/m,
    );
  });

  it("lists the five decisions newest first, joined to their payment entries and to the chain", async () => {
    const lines = paymentsCsv(await decisionRows(snapshot, "testnet"), snapshot.taken_at)
      .slice(1)
      .split("\r\n")
      .filter((l) => l !== "");
    const [header, ...rows] = lines;
    // The same header in every file: the time the snapshot read the chain is the Chain read column of each row.
    expect(header).toBe(
      "Date (UTC),Mandate,Label,Payee,Amount (USDC),Decision,Reason,Spend id,Status now,Chain read (UTC),Spend transaction,Explorer link,Invoice SHA-256,Ledger seq",
    );
    expect(rows.map((r) => r.split(",").at(-1))).toEqual(["5", "4", "3", "1", "0"]);
    const read = "2026-11-09 11:58:06";
    expect(snapshot.taken_at.startsWith(read.replace(" ", "T"))).toBe(true);
    const tx = (hash: string) => `${hash},https://testnet.nearblocks.io/txns/${hash}`;
    // INV-2003: the payment entry says held; the chain says paid, after the approver's approve. The Spend
    // transaction is the spend tx that held it, not the approve tx, which no ledger entry records.
    expect(demo.spends[1]?.approve_tx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(demo.spends[1]?.spend_tx).not.toBe(demo.spends[1]?.approve_tx);
    expect(rows[0]).toBe(
      `2026-11-09 11:53:32,1,Sample PO-1001,probarion-payee.testnet,4,allow,"above the mandate's approval limit, the contract held it for an approver (payment entry at seq 6)",2,paid,${read},${tx(demo.spends[1]?.spend_tx ?? "")},${sha256("invoice-INV-2003.txt")},5`,
    );
    expect(rows[0]).not.toContain(demo.spends[1]?.approve_tx ?? "approve_tx");
    // INV-2002, the changed bank: refused by code, nothing sent, so no payee: the Reason names the account the
    // invoice gave and the mandate's. The reason holds a comma, so it is quoted.
    expect(rows[2]).toBe(
      `2026-11-09 11:49:20,1,Sample PO-1001,,2,refuse,"refused by mandate.payee_mismatch, nothing sent: invoice names NEAR account new-account.testnet; the mandate pays probarion-payee.testnet",,no spend,${read},,,${sha256("invoice-INV-2002.txt")},3`,
    );
    // INV-2001: paid by spend 1.
    expect(rows[3]).toBe(
      `2026-11-09 11:47:27,1,Sample PO-1001,probarion-payee.testnet,2,allow,,1,paid,${read},${tx(demo.spends[0]?.spend_tx ?? "")},${sha256("invoice-INV-2001.txt")},1`,
    );
  });
});
