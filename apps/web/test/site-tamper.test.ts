// The ledger test on the public site, through the real `runChecks` on the real fixture. The results here are the ones
// the page promises, down to the verifier's own words.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { firstBrokenSeq, runChecks, type Snapshot } from "@probarion/core";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TamperPanel } from "@/components/site/TamperPanel";
import { RECORDED_RESULT, TAMPER_COPY } from "@/lib/site/facts";
import {
  applyTamper,
  ledgerRows,
  TAMPER_EDITS,
  type TamperEditId,
  verifyTamper,
} from "@/lib/site/tamper";
import { checkView, passCaveat, resultSummary, runVerifier } from "@/lib/site/tamper-view";
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

describe("what the panel shows for a check", () => {
  it("says not run for a check the verifier did not return, and never pass", () => {
    const view = checkView(undefined);
    expect(view.word).toBe("not run");
    expect(view.bad).toBe(true);
  });

  it("shows a failed check's detail in full, as the verifier wrote it", () => {
    const detail = "anchor 3 covers 5 entries; not the whole ledger";
    const view = checkView({ id: "c", status: "fail", detail });
    expect(view).toMatchObject({ word: "fail", bad: true, why: detail, caveat: "" });
  });

  it("shows only what a passing check says it did not do", () => {
    expect(passCaveat("5 entries: every body_hash and link recomputes")).toBe("");
    expect(passCaveat("no intents public keys; predecessor auth enabled")).toBe("");
    expect(passCaveat("2 decisions pass; quote not verified offline; A8 not run")).toBe(
      "quote not verified offline; A8 not run",
    );
    const detail =
      "1 anchor matches the ledger; 2 entries after the last anchored count (3) are not chain-attested";
    expect(checkView({ id: "c", status: "pass", detail })).toMatchObject({
      word: "pass",
      bad: false,
      why: "",
      caveat: "2 entries after the last anchored count (3) are not chain-attested",
    });
  });

  it("shows nothing for a part that starts with 0 entries, because nothing is left undone", () => {
    const detail =
      "3 anchors match the ledger; 0 entries after the last anchored count (5) are not chain-attested";
    expect(passCaveat(detail)).toBe("");
    expect(checkView({ id: "c", status: "pass", detail }).caveat).toBe("");
  });

  const runs = () =>
    Promise.all(
      [null, ...TAMPER_EDITS.map((e) => e.id)].map((id) => verifyTamper(SNAPSHOT, id)),
    );

  it("says check e's caveat in one plain sentence, at rest and on every live run", async () => {
    const caveatOfE = (r: typeof RECORDED_RESULT) => checkView(r.checks.find((c) => c.id === "e"));
    for (const r of [RECORDED_RESULT, ...(await runs())]) {
      expect(caveatOfE(r)).toMatchObject({
        word: "pass",
        caveat: "The hardware quote and the request are not checked here.",
      });
    }
  });

  it("shows no CLI flag and no undefined id, at rest or on any live run", async () => {
    for (const r of [RECORDED_RESULT, ...(await runs())]) {
      const shown = JSON.stringify(r.checks.map(checkView));
      expect(shown).not.toContain("--online");
      expect(shown).not.toMatch(/\b(O1|A8)\b/);
      expect(shown).not.toContain("0 entries");
    }
    expect(JSON.stringify(RECORDED_RESULT)).not.toContain("--online");
  });

  it("shows at rest the same caveats a real run gives", async () => {
    const real = await verifyTamper(SNAPSHOT, null);
    const caveats = (r: typeof real) => r.checks.map((c) => [c.id, checkView(c).caveat]);
    expect(caveats(RECORDED_RESULT)).toEqual(caveats(real));
    expect(caveats(real).filter(([, caveat]) => caveat !== "").length).toBeGreaterThan(0);
  });

  it("writes the summary as one sentence, with the first broken entry when there is one", () => {
    const base = { passed: 6, failed: 3, unproven: 0, checks: [] };
    expect(resultSummary({ ...base, firstBroken: 2 }, TAMPER_COPY.firstBroken)).toBe(
      "6 passed, 3 failed, 0 unproven. First broken entry: 2",
    );
    expect(resultSummary({ ...base, firstBroken: null }, TAMPER_COPY.firstBroken)).toBe(
      "6 passed, 3 failed, 0 unproven",
    );
  });
});

describe("running the verifier from a button", () => {
  const result = RECORDED_RESULT;

  it("gives the result of a run", async () => {
    const outcome = await runVerifier<null>(async () => async () => result, null);
    expect(outcome).toEqual({ outcome: "done", result });
  });

  it("tells a failed load from a failed run", async () => {
    const noLoad = await runVerifier<null>(() => Promise.reject(new Error("chunk")), null);
    expect(noLoad).toEqual({ outcome: "load_failed" });
    const noRun = await runVerifier<null>(
      async () => () => Promise.reject(new Error("runChecks threw")),
      null,
    );
    expect(noRun).toEqual({ outcome: "run_failed" });
  });

  it("has words for each failure, and neither calls a stopped run a load problem", () => {
    expect(TAMPER_COPY.loadFailed).toContain("did not load");
    expect(TAMPER_COPY.runFailed).not.toContain("did not load");
    expect(TAMPER_COPY.runFailed).toContain("did not change");
  });
});

describe("the ledger test's markup", () => {
  const html = renderToStaticMarkup(createElement(TamperPanel));

  it("keeps the edit buttons above the table and the fixture path below it", () => {
    const table = html.indexOf("<table");
    const end = html.indexOf("</table>");
    expect(html.indexOf("Change an amount")).toBeLessThan(table);
    expect(html.indexOf("Restore")).toBeLessThan(table);
    expect(html.indexOf("Signed ledger, test fixture")).toBeLessThan(
      html.indexOf("Change an amount"),
    );
    expect(html.indexOf("valid-snapshot.json")).toBeGreaterThan(end);
  });

  it("announces the verdict and each check whole, in a polite panel", () => {
    expect(html).toContain('aria-live="polite"');
    expect(html.match(/aria-atomic="true"/g)?.length).toBe(10);
  });

  it("renders the summary as one text node, so a screen reader does not get bare numbers", () => {
    expect(renderToString(createElement(TamperPanel))).toContain(
      ">9 passed, 0 failed, 0 unproven</span>",
    );
  });

  it("shows the recorded caveat muted, at rest and with no JavaScript", () => {
    expect(html).toMatch(
      /<span class="[^"]*caveat[^"]*">The hardware quote and the request are not checked here\.<\/span>/,
    );
    expect(html).not.toContain("--online");
    expect(html).not.toContain("0 entries");
  });
});
