// The testnet demo vault's evidence in docs/evidence/demo-vault: the site and the README point to it, so it has to hold
// up on its own. The verifier runs on the committed snapshot, and every file is tied to the chain data in it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks, type Snapshot } from "@probarion/core";
import { describe, expect, it } from "vitest";

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
    spends: { id: number; invoice: string; amount: string }[];
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
