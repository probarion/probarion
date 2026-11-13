// The ledger test on the public site, through the real `runChecks` on the real fixture. The results here are the ones
// the page promises, down to the verifier's own words.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { firstBrokenSeq, runChecks, type Snapshot } from "@probarion/core";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import { NextStep } from "@/components/site/NextStep";
import p from "@/components/site/parts.module.css";
import { LedgerTest, TamperPanel } from "@/components/site/TamperPanel";
import { TamperVerdict } from "@/components/site/TamperTest";
import {
  CHECK_LIST,
  FIXTURE_PATH,
  LINKS,
  RECORDED_RESULT,
  SAMPLE_SNAPSHOT,
  TAMPER_COPY,
  TAMPER_EVIDENCE,
  VERIFIER_PATH,
} from "@/lib/site/facts";
import { NEXT_STEP } from "@/lib/site/next-step";
import {
  applyTamper,
  ledgerRows,
  TAMPER_EDITS,
  type TamperEditId,
  verifyTamper,
} from "@/lib/site/tamper";
import {
  checkView,
  notRunLine,
  offersNext,
  passCaveat,
  plainVerdict,
  resultSummary,
  runVerifier,
  statusLine,
} from "@/lib/site/tamper-view";
import fixture from "@/lib/site/valid-snapshot.json";
import { elementsOf } from "./fixtures/elements";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "..", "..");
const SNAPSHOT = fixture as unknown as Snapshot;
const read = (...parts: string[]) => readFileSync(join(WEB, "src", ...parts), "utf8");
/** Text as a reader sees it: tags dropped, entities decoded, white space collapsed. */
const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("the fixture", () => {
  it("is a byte-for-byte copy of the core test fixture", () => {
    const core = readFileSync(
      join(ROOT, "packages", "core", "test", "fixtures", "valid-snapshot.json"),
    );
    const copy = readFileSync(join(WEB, "src", "lib", "site", "valid-snapshot.json"));
    expect(copy.equals(core)).toBe(true);
  });

  it("is served by the site, byte for byte, at the address the landing's download line names", () => {
    const core = readFileSync(join(ROOT, ...FIXTURE_PATH.split("/")));
    const served = readFileSync(join(WEB, "public", ...SAMPLE_SNAPSHOT.path.split("/")));
    expect(served.equals(core)).toBe(true);
    const url = new URL(SAMPLE_SNAPSHOT.url);
    expect(url.origin).toBe("https://probarion.xyz");
    expect(url.pathname).toBe(SAMPLE_SNAPSHOT.path);
    // `curl -O` names the file after the URL's last segment, and the verify line reads that name.
    expect(url.pathname.split("/").at(-1)).toBe(SAMPLE_SNAPSHOT.file);
  });

  it("has the five entries the copy says it has", () => {
    expect(SNAPSHOT.ledger).toHaveLength(5);
  });

  it("gives the table's rows, read from the fixture", () => {
    expect(ledgerRows(SNAPSHOT)).toEqual([
      { seq: 0, kind: "Decision", outcome: "Allow", mandate: "1", amount: "25.000000" },
      { seq: 1, kind: "Payment", outcome: "Paid", mandate: "1", amount: "25.000000" },
      { seq: 2, kind: "Decision", outcome: "Allow", mandate: "2", amount: "40.000000" },
      { seq: 3, kind: "Payment", outcome: "Withdrawal to Base", mandate: "2", amount: "40.000000" },
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

  it("says under each button what it will do, and each line is what the edit really does", () => {
    expect(TAMPER_EDITS.map((e) => e.effect)).toEqual([
      "Entry 2: 40 USDC becomes 0.000001 USDC.",
      "Entry 4 is erased from the ledger.",
      "Entry 4: refuse becomes allow.",
    ]);
    for (const edit of TAMPER_EDITS) {
      expect(edit.effect, edit.id).toMatch(new RegExp(`^Entry ${edit.seq}\\b`));
    }
    const before = ledgerRows(SNAPSHOT).find((r) => r.seq === 2);
    const after = ledgerRows(applyTamper(SNAPSHOT, "amount")).find((r) => r.seq === 2);
    expect([before?.amount, after?.amount]).toEqual(["40.000000", "0.000001"]);
    expect(applyTamper(SNAPSHOT, "erase").ledger.some((e) => e.body.seq === 4)).toBe(false);
    expect(SNAPSHOT.ledger[4]?.body.verdict).toBe("refuse");
    expect(applyTamper(SNAPSHOT, "verdict").ledger[4]?.body.verdict).toBe("allow");
    // Nothing is re-signed: every entry left keeps its hash, signature, signer and link.
    const sealed = (s: Snapshot) =>
      new Map(s.ledger.map((e) => [e.body.seq, [e.body_hash, e.sig, e.signer, e.link]]));
    for (const { id } of TAMPER_EDITS) {
      const original = sealed(SNAPSHOT);
      for (const [seq, seal] of sealed(applyTamper(SNAPSHOT, id))) {
        expect(seal, `${id} ${seq}`).toEqual(original.get(seq));
      }
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
    Promise.all([null, ...TAMPER_EDITS.map((e) => e.id)].map((id) => verifyTamper(SNAPSHOT, id)));

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

describe("the left card's status line", () => {
  it("does not show the old verdict beside the buttons when a press produced no result", () => {
    const line = notRunLine(TAMPER_COPY.notRun);
    expect(line).toBe("Not run. The verifier did not finish.");
    expect(line).not.toMatch(/PASS|FAIL/);
    const source = readFileSync(
      fileURLToPath(new URL("../src/components/site/TamperTest.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("failed === null");
    expect(source).toContain("notRunLine(copy.notRun)");
  });

  it("says the verdict word first, at rest", () => {
    expect(statusLine(RECORDED_RESULT.ok, TAMPER_COPY.atRest)).toBe("PASS. As recorded.");
  });

  it("says the verdict the real verifier gives for each edit", async () => {
    const lines = await Promise.all(
      TAMPER_EDITS.map(async ({ id, summary }) =>
        statusLine((await verifyTamper(SNAPSHOT, id)).ok, summary),
      ),
    );
    expect(lines).toEqual([
      "FAIL. Entry 2 edited: 40 USDC became 0.000001 USDC.",
      "FAIL. Entry 4 erased from the ledger.",
      "FAIL. Entry 4 edited: refuse became allow.",
    ]);
  });
});

describe("the plain verdict", () => {
  const verdictOf = async (id: TamperEditId | null) =>
    plainVerdict(await verifyTamper(SNAPSHOT, id), TAMPER_COPY.firstBroken);

  it("says in plain words what the real verifier found, for the fixture and for each edit", async () => {
    expect(await verdictOf(null)).toBe("All 9 offline checks pass.");
    expect(await verdictOf("amount")).toBe(
      "Entry 2 was changed after it was signed, so its signature no longer matches.",
    );
    expect(await verdictOf("erase")).toBe(
      "Entry 4 is missing, but the vault anchored a count that includes it.",
    );
    expect(await verdictOf("verdict")).toBe(
      "Entry 4 was changed after it was signed, so its signature no longer matches.",
    );
  });

  it("says the same at rest as a real run of the untouched fixture", async () => {
    expect(plainVerdict(RECORDED_RESULT, TAMPER_COPY.firstBroken)).toBe(await verdictOf(null));
  });

  it("uses none of the verifier's own terms", async () => {
    for (const id of [null, ...TAMPER_EDITS.map((e) => e.id)]) {
      expect(await verdictOf(id), String(id)).not.toMatch(/body_hash|recompute|\bseq\b|--online/);
    }
  });

  it("counts the checks it was given, and falls back to the counts for any other result", () => {
    const pass = (id: string) => ({ id: id as "a", status: "pass" as const, detail: "" });
    const eight = { ok: true, firstBroken: null, failed: 0, unproven: 0 };
    expect(
      plainVerdict(
        { ...eight, passed: 8, checks: "abcdefgh".split("").map(pass) },
        TAMPER_COPY.firstBroken,
      ),
    ).toBe("All 8 offline checks pass.");
    const onlyD = {
      ok: false,
      firstBroken: 2,
      passed: 8,
      failed: 1,
      unproven: 0,
      checks: [{ id: "d" as const, status: "fail" as const, detail: "spend 2 does not match" }],
    };
    expect(plainVerdict(onlyD, TAMPER_COPY.firstBroken)).toBe(
      "8 passed, 1 failed, 0 unproven. First broken entry: 2",
    );
    const skipped = {
      ok: true,
      firstBroken: null,
      passed: 1,
      failed: 0,
      unproven: 0,
      checks: [pass("a"), { id: "b" as const, status: "skip" as const, detail: "" }],
    };
    expect(plainVerdict(skipped, TAMPER_COPY.firstBroken)).toBe("1 passed, 0 failed, 0 unproven");
  });

  it("names a cause and an entry only when the verifier's own words name them", () => {
    type Failing = { id: "a" | "b" | "c"; detail: string };
    const result = (firstBroken: number, ...failing: Failing[]) => ({
      ok: false,
      firstBroken,
      passed: 9 - failing.length,
      failed: failing.length,
      unproven: 0,
      checks: failing.map((f) => ({ ...f, status: "fail" as const })),
    });
    const verdict = (r: ReturnType<typeof result>) => plainVerdict(r, TAMPER_COPY.firstBroken);
    // Words the panel has no plain sentence for get the counts.
    expect(
      verdict(result(3, { id: "a", detail: "entry 3 signature is not by the ledger key" })),
    ).toBe("8 passed, 1 failed, 0 unproven. First broken entry: 3");
    expect(verdict(result(3, { id: "c", detail: "anchor 2 root does not match the ledger" }))).toBe(
      "8 passed, 1 failed, 0 unproven. First broken entry: 3",
    );
    // An edited link is not an edited body: the signature still holds.
    expect(
      verdict(
        result(
          2,
          { id: "b", detail: "entry 3 link does not recompute" },
          { id: "c", detail: "anchor 1 root does not match entries 0 to 2" },
        ),
      ),
    ).toBe("7 passed, 2 failed, 0 unproven. First broken entry: 2");
    // The entry is the one the verifier names, not the lowest broken entry across the checks.
    expect(
      verdict(
        result(
          2,
          { id: "a", detail: "entry 3 body_hash does not recompute from its body: a signature" },
          { id: "c", detail: "anchor 1 root does not match entries 0 to 2" },
        ),
      ),
    ).toBe("Entry 3 was changed after it was signed, so its signature no longer matches.");
    // More than one entry cut from the end is not "entry N is missing".
    expect(
      verdict(
        result(3, {
          id: "c",
          detail: "anchor 3 covers 5 entries but the ledger has 3: entry 3 and later are missing",
        }),
      ),
    ).toBe("8 passed, 1 failed, 0 unproven. First broken entry: 3");
  });
});

describe("the verdict panel after a run", () => {
  const next = createElement("a", { href: "/proof" }, "next step");
  const panel = async (id: TamperEditId | null, live: boolean, withNext = true) =>
    renderToStaticMarkup(
      createElement(TamperVerdict, {
        result: id === null && !live ? RECORDED_RESULT : await verifyTamper(SNAPSHOT, id),
        checks: CHECK_LIST,
        live,
        copy: TAMPER_COPY,
        next: withNext ? next : undefined,
      }),
    );

  it("puts the plain verdict beside the word, and the verifier's own words in a closed disclosure", async () => {
    const html = await panel("amount", true);
    expect(html).toMatch(
      /<b class="[^"]*fail[^"]*">FAIL<\/b><p class="[^"]*">Entry 2 was changed after it was signed, so its signature no longer matches\.<\/p>/,
    );
    const details = html.indexOf("<details");
    expect(details).toBeGreaterThan(html.indexOf("</ul>"));
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html.slice(details)).toMatch(/^<details[^>]*><summary[^>]*>Verifier detail<\/summary>/);
    const inside = html.slice(details, html.indexOf("</details>"));
    // The counts are above, with the verdict: the disclosure holds the verifier's words only.
    expect(inside).not.toContain("passed");
    expect(inside).toContain(
      "entry 2 body_hash does not recompute from its body: a signature over a hash the body does not produce proves nothing about the body",
    );
    expect(inside).toContain(
      "spend 2 does not match its decision seq 2 (spend vs decision): amount 40000000 vs 1",
    );
    // The list above keeps each check's word, without the verifier's words.
    expect(html.slice(0, details)).not.toContain("body_hash");
    expect(html.slice(0, details).match(/class="[^"]*checkBad[^"]*"/g)).toHaveLength(3);
  });

  it("names each failed check in the disclosure, and only the failed ones", async () => {
    const html = await panel("erase", true);
    const inside = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    expect(inside).toContain(
      "anchor 3 covers 5 entries but the ledger has 4: entry 4 and later are missing",
    );
    expect(inside.match(/<li/g)).toHaveLength(1);
    expect(inside).not.toContain("every body_hash and link recomputes");
  });

  it("has no disclosure when every check passes", async () => {
    expect(await panel(null, false)).not.toContain("<details");
    expect(await panel(null, true)).not.toContain("<details");
  });

  /** The block a screen reader hears whole, the verdict: from the only aria-atomic div to its end. */
  const atomic = (html: string) => {
    const at = html.indexOf('aria-atomic="true"');
    return html.slice(at, html.indexOf("</div>", at));
  };

  it("puts the next step it is given under the verdict, after the run note and before the checks", async () => {
    for (const id of TAMPER_EDITS.map((e) => e.id)) {
      const html = await panel(id, true);
      expect(html, id).toMatch(
        /<p[^>]*>Run in your browser just now\.<\/p><\/div><div class="[^"]*" aria-live="polite"><a href="\/proof">next step<\/a><\/div><ul/,
      );
      // Outside the block read whole, so that a press that did not finish does not read it again.
      expect(atomic(html), id).not.toContain("next step");
    }
    expect(await panel("amount", true, false)).not.toContain("next step");
  });

  it("says a press did not finish under the verdict, outside the block read whole, in a live region of its own", () => {
    const html = renderToStaticMarkup(
      createElement(TamperVerdict, {
        result: RECORDED_RESULT,
        checks: CHECK_LIST,
        live: false,
        copy: TAMPER_COPY,
        error: TAMPER_COPY.runFailed,
      }),
    );
    const error = html.indexOf(`>${TAMPER_COPY.runFailed}</p>`);
    expect(error).toBeGreaterThan(html.indexOf("</div>"));
    expect(error).toBeLessThan(html.indexOf("<ul"));
    expect(atomic(html)).not.toContain(TAMPER_COPY.runFailed);
    // Only the verdict is read whole; the checks under it stay still, readable on demand.
    expect(html.match(/aria-atomic="true"/g)).toHaveLength(1);
    // The error, and a next step, come into a polite region that is always in the page, after the verdict's.
    expect(html.match(/aria-live="polite"/g)).toHaveLength(2);
    expect(html.lastIndexOf('aria-live="polite"', error)).toBeGreaterThan(
      html.indexOf('aria-atomic="true"'),
    );
    // The verdict is busy while a press runs, so it is read once, when the new one is in.
    const source = read("components", "site", "TamperTest.tsx");
    expect(source).toMatch(/aria-live="polite"\s+aria-atomic="true"\s+aria-busy=\{busy\}/);
    expect(source).toMatch(/<TamperVerdict\b[^>]*busy=\{busy !== null\}/);
    expect(source).not.toMatch(/className=\{t\.readout\}[^>]*aria-live/);
    expect(source).toMatch(
      /error=\{\s*failed === null\s*\? undefined\s*: failed === "load_failed"\s*\? copy\.loadFailed\s*: copy\.runFailed\s*\}/,
    );
  });

  it("shows the counts with the verdict at every state, once, and keeps the first broken entry on one line", async () => {
    const rest = await panel(null, false);
    expect(visible(atomic(rest))).toContain(
      "All 9 offline checks pass. 9 passed, 0 failed, 0 unproven",
    );
    const amount = await panel("amount", true);
    expect(atomic(amount)).toMatch(
      />6 passed, 3 failed, 0 unproven\. <span class="[^"]*keep[^"]*">First broken entry: 2<\/span><\/p>/,
    );
    // A result the panel has no sentence for already reads as the counts, so they are not said twice.
    const onlyD = {
      ok: false,
      firstBroken: 2,
      passed: 8,
      failed: 1,
      unproven: 0,
      checks: [{ id: "d" as const, status: "fail" as const, detail: "spend 2 does not match" }],
    };
    const html = renderToStaticMarkup(
      createElement(TamperVerdict, {
        result: onlyD,
        checks: CHECK_LIST,
        live: true,
        copy: TAMPER_COPY,
      }),
    );
    expect(html.split("8 passed, 1 failed, 0 unproven").length).toBe(2);
  });

  it("titles the readout, outside the block read whole", async () => {
    const html = await panel(null, false);
    // Opened as every part of the page is (bits.tsx PartHead).
    expect(html).toMatch(/^<div class="[^"]*"><h3 class="[^"]*">Verifier result<\/h3><\/div><div /);
    expect(atomic(html)).not.toContain("Verifier result");
  });

  it("offers the next step only for a run the verifier failed, while that run is the one shown", async () => {
    const failedRun = await verifyTamper(SNAPSHOT, "amount");
    const restored = await verifyTamper(SNAPSHOT, null);
    expect(offersNext({ live: true, result: failedRun }, false)).toBe(true);
    // At rest, after Restore, and for a result that is only unproven.
    expect(offersNext({ live: false, result: RECORDED_RESULT }, false)).toBe(false);
    expect(offersNext({ live: true, result: restored }, false)).toBe(false);
    expect(offersNext({ live: true, result: { failed: 0 } }, false)).toBe(false);
    // A later press that did not finish leaves the old result on screen, but not its next step.
    expect(offersNext({ live: true, result: failedRun }, true)).toBe(false);
    const source = readFileSync(
      fileURLToPath(new URL("../src/components/site/TamperTest.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("next={offersNext(shown, failed !== null) ? next : undefined}");
  });

  it("gives the next step on the landing page (/proof leaves it out: test/proof-routes.test.ts)", () => {
    expect(elementsOf(Home(), LedgerTest)).toHaveLength(1);
    const panels = elementsOf(LedgerTest(), TamperPanel);
    expect(panels.map((p) => (p.props as { next?: boolean }).next)).toEqual([true]);
  });

  it("links the landing page's next step to /proof, after the word Caught", () => {
    const html = renderToStaticMarkup(createElement(NextStep, { step: NEXT_STEP.tamper }));
    expect(html).toMatch(
      /^<p[^>]*>Caught\. <a[^>]*href="\/proof"[^>]*>A vault&#x27;s public proof page runs these same checks <span aria-hidden="true">→<\/span><\/a><\/p>$/,
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
  const at = (part: string) => {
    const i = html.indexOf(part);
    expect(i, part).toBeGreaterThanOrEqual(0);
    return i;
  };

  it("puts the edits first, then the ledger: its status line, the table and its two files, then the result", () => {
    const order = [
      ">Try one edit</h3>",
      "Nothing is re-signed.",
      ">Change an amount</span>",
      ">Entry 2: 40 USDC becomes 0.000001 USDC.</p>",
      ">Erase a refusal</span>",
      ">Entry 4 is erased from the ledger.</p>",
      ">Turn a refusal into an approval</span>",
      ">Entry 4: refuse becomes allow.</p>",
      ">Restore</span>",
      ">Signed ledger, test fixture</span>",
      ">PASS. As recorded.</span>",
      "<table",
      "</table>",
      "<dt>Fixture</dt>",
      `<code>${FIXTURE_PATH.split("/").at(-1)}</code>`,
      "<dt>Verifier</dt>",
      `<code>${VERIFIER_PATH.split("/").at(-1)}</code>`,
      ">Verifier result</h3>",
    ];
    for (const [i, part] of order.entries()) {
      if (i > 0) expect(at(order[i - 1] ?? ""), part).toBeLessThan(at(part));
    }
  });

  it("names its two parts with headings, under the h2 the landing page and /proof give it", () => {
    expect(html.match(/<h[1-6][ >]/g)).toEqual(["<h3 ", "<h3 "]);
    expect(html).toMatch(/<h3 class="[^"]*" id="[^"]+">Try one edit<\/h3>/);
    expect(html).toMatch(/<h3 class="[^"]*">Verifier result<\/h3>/);
  });

  it("ties each button to the line under it and the list to its heading, with ids React makes", () => {
    const heading = /<h3 [^>]*id="([^"]+)">Try one edit<\/h3>/.exec(html)?.[1];
    expect(heading).toBeDefined();
    expect(html).toMatch(new RegExp(`<ul class="[^"]*" aria-labelledby="${heading}" role="list">`));
    for (const { label, effect } of TAMPER_EDITS) {
      const button = new RegExp(
        `<button [^>]*aria-describedby="([^"]+)"[^>]*><span>${label}</span>`,
      );
      const described = button.exec(html)?.[1];
      expect(described, label).toBeDefined();
      expect(html, label).toContain(`id="${described}">${effect}</p>`);
    }
    // Two panels on one page would not share an id: none is written by hand.
    const two = renderToStaticMarkup(
      createElement(Fragment, null, createElement(TamperPanel), createElement(TamperPanel)),
    );
    const ids = [...two.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(ids.length);
    const source = read("components", "site", "TamperTest.tsx");
    expect(source).toContain("useId()");
    expect(source).not.toMatch(/\bid="/);
  });

  it("says by the buttons that they need JavaScript, straight after the list of edits", () => {
    const note = at("<noscript>");
    expect(note).toBeGreaterThan(at("</ul>"));
    expect(note).toBeLessThan(at(">Restore</span>"));
    expect(html.slice(note)).toMatch(
      /^<noscript><p class="[^"]*">The buttons need JavaScript\. The result here is the recorded run of the same verifier\.<\/p><\/noscript>/,
    );
  });

  it("names the two files under the ledger by their role, each a link to GitHub in a new tab, with the arrow", () => {
    for (const { label, path, href } of TAMPER_EVIDENCE) {
      // The folders may break after each "/" on a phone; the file name stays on one line with the arrow.
      const cut = path.lastIndexOf("/") + 1;
      const folders = path
        .slice(0, cut)
        .split("/")
        .slice(0, -1)
        .map((d) => `${d}/<wbr/>`)
        .join("");
      expect(html, label).toContain(
        `<dt>${label}</dt><dd><a class="${/class="([^"]*link[^"]*)" href="https:\/\/github/.exec(html)?.[1]}" href="${href}" target="_blank" rel="noreferrer"><code>${folders}</code><span class="${p.glue}"><code>${path.slice(cut)}</code><span class="${p.ext}" aria-hidden="true">↗</span></span><span class="sr-only"> (opens in a new tab)</span></a></dd>`,
      );
    }
    expect(TAMPER_EVIDENCE[0]?.href).toBe(LINKS.fixture);
  });

  it("announces the verdict whole, in a polite region, and leaves the checks still", () => {
    expect(html).toContain('aria-live="polite"');
    expect(html.match(/aria-atomic="true"/g)?.length).toBe(1);
    const verdict = html.indexOf('aria-atomic="true"');
    expect(html.slice(verdict, html.indexOf("</div>", verdict))).toContain(">PASS</b>");
    expect(html.slice(html.indexOf("<ul", verdict))).not.toMatch(/aria-(live|atomic)=/);
  });

  it("puts the verdict word in the ledger's status line, after the buttons and outside the live regions", () => {
    const line = at(">PASS. As recorded.</span>");
    expect(line).toBeGreaterThan(at("Signed ledger, test fixture"));
    expect(line).toBeGreaterThan(at(">Restore</span>"));
    expect(html.match(/aria-live=/g)?.length).toBe(2);
    expect(line).toBeLessThan(at("aria-live="));
  });

  it("renders the plain verdict as one text node, so a screen reader reads it whole", () => {
    expect(renderToString(createElement(TamperPanel))).toContain(">All 9 offline checks pass.</p>");
  });

  it("shows no next step and no disclosure at rest, with or without one to give", () => {
    for (const out of [html, renderToStaticMarkup(createElement(TamperPanel, { next: true }))]) {
      expect(out).not.toContain("<details");
      expect(out).not.toContain('href="/proof"');
    }
  });

  it("shows the recorded caveat apart from the hint, in the partial tone, at rest and with no JavaScript", () => {
    expect(html).toMatch(
      /<span class="[^"]*caveat[^"]*">The hardware quote and the request are not checked here\.<\/span>/,
    );
    expect(html).not.toContain("--online");
    expect(html).not.toContain("0 entries");
    // Its words say it; the colour is the page's partial tone, and no other line of the readout uses it.
    const css = read("components", "site", "tamper.module.css");
    const rule = css.slice(
      css.indexOf("\n.caveat {"),
      css.indexOf("}", css.indexOf("\n.caveat {")),
    );
    expect(rule).toContain("color: var(--color-wait)");
    expect(css.match(/var\(--color-(?:wait|gold[a-z-]*)\)/g)).toEqual(["var(--color-wait)"]);
  });
});

describe("the files under the ledger", () => {
  it("are the fixture the buttons edit and the verifier that exports runChecks, both in the repository", () => {
    expect(TAMPER_EVIDENCE.map((e) => [e.label, e.path])).toEqual([
      ["Fixture", FIXTURE_PATH],
      ["Verifier", VERIFIER_PATH],
    ]);
    for (const { path, href } of TAMPER_EVIDENCE) {
      expect(existsSync(join(ROOT, ...path.split("/"))), path).toBe(true);
      expect(href).toBe(`https://github.com/probarion/probarion/blob/main/${path}`);
    }
    // The Verifier label is true: the file defines runChecks, and @probarion/core exports it from there.
    const verify = readFileSync(join(ROOT, ...VERIFIER_PATH.split("/")), "utf8");
    expect(verify).toMatch(/^export async function runChecks\(/m);
    expect(readFileSync(join(ROOT, "packages", "core", "src", "index.ts"), "utf8")).toContain(
      'export * from "./verify.js";',
    );
  });
});
