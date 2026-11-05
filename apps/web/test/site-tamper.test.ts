// The ledger test on the public site, through the real `runChecks` on the real fixture. The results here are the ones
// the page promises, down to the verifier's own words.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { firstBrokenSeq, runChecks, type Snapshot } from "@probarion/core";
import { describe, expect, it } from "vitest";
import {
  applyTamper,
  ledgerRows,
  TAMPER_EDITS,
  type TamperEditId,
  verifyTamper,
} from "@/lib/site/tamper";
import fixture from "@/lib/site/valid-snapshot.json";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "..", "..");
const SNAPSHOT = fixture as unknown as Snapshot;

describe("the fixture", () => {
  it("is a byte-for-byte copy of the core test fixture", () => {
    const core = readFileSync(
      join(ROOT, "packages", "core", "test", "fixtures", "valid-snapshot.json"),
    );
    const copy = readFileSync(join(WEB, "src", "lib", "site", "valid-snapshot.json"));
    expect(copy.equals(core)).toBe(true);
  });

  it("has the five entries the copy says it has", () => {
    expect(SNAPSHOT.ledger).toHaveLength(5);
  });

  it("gives the table's rows, read from the fixture", () => {
    expect(ledgerRows(SNAPSHOT)).toEqual([
      { seq: 0, kind: "Decision", outcome: "Allow", mandate: "1", amount: "25.000000" },
      { seq: 1, kind: "Payment", outcome: "Paid", mandate: "1", amount: "25.000000" },
      { seq: 2, kind: "Decision", outcome: "Allow", mandate: "2", amount: "40.000000" },
      { seq: 3, kind: "Payment", outcome: "Burned for Base", mandate: "2", amount: "40.000000" },
      {
        seq: 4,
        kind: "Decision",
        outcome: "Refuse: payee mismatch",
        mandate: "1",
        amount: "25.000000",
      },
    ]);
  });
});

describe("the ledger test runs the real verifier", () => {
  const failing = (r: { checks: { id: string; status: string }[] }) =>
    r.checks.filter((c) => c.status === "fail").map((c) => c.id);

  it("passes the untouched fixture: 9 passed, 0 failed", async () => {
    const r = await verifyTamper(SNAPSHOT, null);
    expect(r.ok).toBe(true);
    expect(r.firstBroken).toBeNull();
    expect([r.passed, r.failed, r.unproven]).toEqual([9, 0, 0]);
    expect(failing(r)).toEqual([]);
  });

  it("changing entry 2's amount from 40000000 to 1 breaks entry 2: checks a, b, d", async () => {
    expect(SNAPSHOT.ledger[2]?.body.amount).toBe("40000000");
    expect(applyTamper(SNAPSHOT, "amount").ledger[2]?.body.amount).toBe("1");
    const r = await verifyTamper(SNAPSHOT, "amount");
    expect(r.ok).toBe(false);
    expect(r.firstBroken).toBe(2);
    expect(failing(r)).toEqual(["a", "b", "d"]);
    expect(r.checks.find((c) => c.id === "d")?.detail).toBe(
      "spend 2 does not match its decision seq 2 (spend vs decision): amount 40000000 vs 1",
    );
  });

  it("erasing the refusal at seq 4 breaks entry 4: check c, in the verifier's own words", async () => {
    const edited = applyTamper(SNAPSHOT, "erase");
    expect(edited.ledger.map((e) => e.body.seq)).toEqual([0, 1, 2, 3]);
    const r = await verifyTamper(SNAPSHOT, "erase");
    expect(r.ok).toBe(false);
    expect(r.firstBroken).toBe(4);
    expect(failing(r)).toEqual(["c"]);
    expect(r.checks.find((c) => c.id === "c")?.detail).toBe(
      "anchor 3 covers 5 entries but the ledger has 4: entry 4 and later are missing",
    );
  });

  it("turning the refusal at seq 4 into an approval breaks entry 4: checks a, b", async () => {
    expect(SNAPSHOT.ledger[4]?.body.verdict).toBe("refuse");
    expect(applyTamper(SNAPSHOT, "verdict").ledger[4]?.body.verdict).toBe("allow");
    const r = await verifyTamper(SNAPSHOT, "verdict");
    expect(r.ok).toBe(false);
    expect(r.firstBroken).toBe(4);
    expect(failing(r)).toEqual(["a", "b"]);
  });

  it("agrees with runChecks and firstBrokenSeq called directly", async () => {
    for (const id of ["amount", "erase", "verdict"] satisfies TamperEditId[]) {
      const direct = await runChecks(applyTamper(SNAPSHOT, id));
      const r = await verifyTamper(SNAPSHOT, id);
      expect(r.ok).toBe(direct.ok);
      expect(r.firstBroken).toBe(firstBrokenSeq(direct));
    }
  });

  it("does not mutate the fixture it edits", async () => {
    const before = JSON.stringify(SNAPSHOT);
    for (const { id } of TAMPER_EDITS) {
      applyTamper(SNAPSHOT, id);
      await verifyTamper(SNAPSHOT, id);
    }
    expect(JSON.stringify(SNAPSHOT)).toBe(before);
  });

  it("offers exactly the three edits, and each row change is what the edited fixture really shows", () => {
    expect(TAMPER_EDITS.map((e) => e.id)).toEqual(["amount", "erase", "verdict"]);
    for (const edit of TAMPER_EDITS) {
      const rows = ledgerRows(applyTamper(SNAPSHOT, edit.id));
      const row = rows.find((r) => r.seq === edit.seq);
      if (edit.change.erased === true) expect(row).toBeUndefined();
      if (edit.change.amount !== undefined) expect(row?.amount).toBe(edit.change.amount);
      if (edit.change.outcome !== undefined) expect(row?.outcome).toBe(edit.change.outcome);
    }
  });
});
