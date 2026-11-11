// renderReport and the verify exit code, on hand-made reports (the CLI tests run them on real ones).
import type { CheckResult, Snapshot, VerifyReport } from "@probarion/core";
import { applyOnlineChecks, type OnlineAttestationVerifier } from "@probarion/sdk";
import { describe, expect, it } from "vitest";
import {
  CLOCK_HINT,
  O1_LEGEND,
  O2_LEGEND,
  onlineDidNotRun,
  onlineLines,
  printable,
  REMOVED,
  renderReport,
  verifyExitCode,
  verifyOutcome,
} from "../src/report.js";

const IDS = ["a", "b", "c", "d", "e", "f", "g", "h", "i"] as const;

function report(
  statuses: Partial<Record<(typeof IDS)[number], CheckResult["status"]>> = {},
  extra: Partial<VerifyReport> = {},
): VerifyReport {
  const checks: CheckResult[] = IDS.map((id) => ({
    id,
    name: `check-${id}`,
    status: statuses[id] ?? "pass",
    detail: `detail of ${id}`,
  }));
  return {
    vault: "acme.vaults.probarion.testnet",
    network: "testnet",
    ok: checks.every((c) => c.status !== "fail" && c.status !== "unproven"),
    checks,
    entries: 4,
    anchors: 2,
    generated_at: "2026-11-05T12:00:00.000Z",
    unproven: [],
    ...extra,
  };
}

describe("verifyExitCode: 0 pass, 1 fail (a fail always wins), 2 unproven", () => {
  it("is 0 when every check passes, and a skipped check does not change that", () => {
    expect(verifyExitCode(report())).toBe(0);
    expect(verifyExitCode(report({ i: "skip" }))).toBe(0);
  });

  it("is 1 when any check fails, also when another one is unproven", () => {
    expect(verifyExitCode(report({ c: "fail" }))).toBe(1);
    const both = report(
      { a: "fail", h: "unproven" },
      { unproven: [{ check: "h", spend_id: 1, reason: "approver_tx" }] },
    );
    expect(verifyExitCode(both)).toBe(1);
  });

  it("is 2 when nothing fails and a check is unproven", () => {
    const r = report(
      { h: "unproven" },
      { unproven: [{ check: "h", spend_id: 3, reason: "not_recorded" }] },
    );
    expect(verifyExitCode(r)).toBe(2);
  });

  it("is never 0 for a report that is not ok, lists unproven burns, or has no checks", () => {
    expect(verifyExitCode(report({}, { ok: false }))).toBe(1);
    expect(
      verifyExitCode(
        report({}, { unproven: [{ check: "h", spend_id: 1, reason: "tx_unavailable" }] }),
      ),
    ).toBe(2);
    expect(verifyExitCode(report({}, { checks: [] }))).toBe(1);
    expect(verifyOutcome(report({}, { checks: [] }))).toBe("fail");
  });
});

describe("renderReport", () => {
  it("prints one row per check, the counts and RESULT: PASS", () => {
    const text = renderReport(report({ i: "skip" }));
    expect(text).toContain("Probarion verify: acme.vaults.probarion.testnet (testnet)\n");
    expect(text).toContain("entries 4, anchors 2, generated 2026-11-05T12:00:00.000Z\n");
    expect(text).toContain("a  check-a                PASS      detail of a\n");
    expect(text).toContain("i  check-i                SKIP      detail of i\n");
    expect(text).toContain("\n8 passed, 0 failed, 0 unproven, 1 skipped\nRESULT: PASS\n");
    expect(text).not.toContain("online:");
  });

  it("names the lowest broken seq of the failing checks", () => {
    const r = report({ b: "fail", d: "fail" });
    const b = r.checks[1] as CheckResult;
    const d = r.checks[3] as CheckResult;
    b.firstBrokenSeq = 7;
    d.firstBrokenSeq = 3;
    const text = renderReport(r);
    expect(text).toContain(
      "b  check-b                FAIL      detail of b [first broken seq 7]\n",
    );
    expect(text).toContain("7 passed, 2 failed, 0 unproven\nRESULT: FAIL (first broken seq 3)\n");
  });

  it("says RESULT: FAIL without a seq when no failing check names one", () => {
    expect(renderReport(report({ f: "fail" }))).toMatch(/\nRESULT: FAIL\n$/);
  });

  it("shows unproven spends under their row, grouped by reason, each with its hint", () => {
    const r = report(
      { h: "unproven" },
      {
        unproven: [
          { check: "h", spend_id: 1, reason: "approver_tx" },
          { check: "h", spend_id: 4, reason: "tx_unavailable" },
          { check: "h", spend_id: 3, reason: "approver_tx" },
          { check: "h", spend_id: 5, reason: "not_recorded" },
          { check: "h", spend_id: 6, reason: "pre_ledger_no_tx" },
        ],
      },
    );
    const text = renderReport(r);
    expect(text).toContain(
      [
        "h  check-h                UNPROVEN  detail of h",
        "   unproven: spends 1, 3 (approver_tx): supply the burn tx with --burn-tx or --proof",
        "   unproven: spend 4 (tx_unavailable): re-run, or add --archival-rpc",
        "   unproven: spend 5 (not_recorded): supply the burn tx with --burn-tx or --proof",
        "   unproven: spend 6 (pre_ledger_no_tx): supply the burn tx with --burn-tx or --proof",
        "i  check-i",
      ].join("\n"),
    );
    expect(text).toContain("8 passed, 0 failed, 1 unproven\nRESULT: UNPROVEN");
    expect(text).not.toMatch(/RESULT: (PASS|FAIL)/);
  });

  it("gives a reason it does not know a hint that points at the detail, never a blank", () => {
    const r = report(
      { h: "unproven" },
      { unproven: [{ check: "h", spend_id: 2, reason: "something_new" as never }] },
    );
    expect(renderReport(r)).toContain(
      "   unproven: spend 2 (something_new): see the check's detail for what is missing\n",
    );
  });

  it("lists under a row only the unproven spends of that check", () => {
    const r = report(
      { h: "unproven" },
      {
        unproven: [
          { check: "h", spend_id: 1, reason: "approver_tx" },
          { check: "g" as never, spend_id: 9, reason: "approver_tx" },
        ],
      },
    );
    const text = renderReport(r);
    expect(text).toContain("   unproven: spend 1 (approver_tx)");
    expect(text).not.toContain("spend 9");
    expect(text).not.toContain("spends 1, 9");
  });

  it("offline: says when the snapshot was taken, that its chain data was not re-read, and how to take it again", () => {
    const r = report(
      { h: "unproven" },
      { unproven: [{ check: "h", spend_id: 2, reason: "tx_unavailable" }] },
    );
    const e = r.checks[4] as CheckResult;
    e.detail = "2 attested decisions pass A1–A7; quote not verified offline (run --online for O1)";
    const text = renderReport(r, { offline: { takenAt: "2026-11-04T09:00:00.000Z" } });
    expect(text).toContain(
      "generated 2026-11-05T12:00:00.000Z\nsnapshot taken 2026-11-04T09:00:00.000Z: its chain data is the file's and was not read from the chain again\n\n",
    );
    expect(text).toContain(
      "   unproven: spend 2 (tx_unavailable): re-run, or add --archival-rpc (when the snapshot is taken: probarion verify --network testnet --vault acme.vaults.probarion.testnet --snapshot <file>)\n",
    );
    expect(text).toContain(
      "quote not verified offline (run --online for O1; re-take the snapshot live with --online)",
    );
    const live = renderReport(r);
    expect(live).not.toContain("snapshot taken");
    expect(live).not.toContain("when the snapshot is taken");
    expect(live).toContain("(run --online for O1)\n");
  });
});

// ---------- --online: a legend for what ran, or why it did not (T16-R1 item 1) ----------
//
// Check e's detail comes from the SDK's real applyOnlineChecks, on a ledger of hand-made attested decisions, so a
// change to the SDK's wording shows up here instead of silently turning the legend on or off.

const NONCE = "ab".repeat(32);
const REPORT_DATA = "cd".repeat(64);

function attested(gpu: boolean): unknown {
  return {
    body: {
      decided_by: "model+rules",
      evidence: {
        nonce: NONCE,
        report: {
          intel_quote: "TEST DOUBLE quote",
          report_data: REPORT_DATA,
          nvidia_payload: gpu ? JSON.stringify({ nonce: NONCE }) : null,
        },
      },
    },
  };
}

function ledgerOf(...entries: unknown[]): Snapshot {
  return { ledger: entries } as unknown as Snapshot;
}

const genuine: OnlineAttestationVerifier = {
  verifyQuote: async () => ({
    reportDataHex: REPORT_DATA,
    tcbStatus: "UpToDate",
    debugEnabled: false,
  }),
  verifyGpu: async () => {},
};

async function online(
  snapshot: Snapshot,
  verifier: OnlineAttestationVerifier | null,
  base: VerifyReport = report(),
): Promise<VerifyReport> {
  return applyOnlineChecks(base, snapshot, verifier);
}

const LEGEND = /online legend/;
const CLAIMS = /verified TEE|TEE verified|attested model verified|\bO[12]: (passed|verified)/i;

describe("the --online lines", () => {
  it("print the O1 and O2 legends when both ran on at least one item and check e passed", async () => {
    const r = await online(ledgerOf(attested(true), attested(true)), genuine);
    expect(r.checks[4]?.detail).toContain("online: 2 DCAP-genuine TDX quotes");
    expect(onlineLines(r, { online: true })).toEqual([O1_LEGEND, O2_LEGEND]);
    expect(O1_LEGEND).toMatch(/^online legend: O1 checks that .* measurement not pinned/);
    expect(O2_LEGEND).toMatch(/^online legend: O2 checks that /);
    const text = renderReport(r, { online: true });
    expect(text).toContain(`\n\n${O1_LEGEND}\n${O2_LEGEND}\n9 passed, 0 failed, 0 unproven\n`);
    expect(text).not.toMatch(CLAIMS);
  });

  it("say O2 did not run when no attested decision carries a GPU payload (0 GPU payloads)", async () => {
    const r = await online(ledgerOf(attested(false)), genuine);
    expect(r.checks[4]?.detail).toContain("and 0 GPU payloads");
    expect(onlineLines(r, { online: true })).toEqual([
      O1_LEGEND,
      "online: O2 did not run (no attested decision carries a GPU payload)",
    ]);
    expect(renderReport(r, { online: true })).not.toContain(O2_LEGEND);
  });

  it("say O1 and O2 did not run when the ledger has no attested decision (0 quotes)", async () => {
    const r = await online(ledgerOf({ body: { decided_by: "rules-only" } }), genuine);
    expect(r.checks[4]?.detail).toContain("online: 0 DCAP-genuine TDX quotes");
    expect(onlineLines(r, { online: true })).toEqual([
      "online: O1 and O2 did not run (no attested decision in this ledger)",
    ]);
    expect(renderReport(r, { online: true })).not.toMatch(LEGEND);
  });

  it("say O1 and O2 did not run when no verifier was available (unavailable)", async () => {
    const r = await online(ledgerOf(attested(true)), null);
    expect(r.checks[4]?.detail).toContain("online: unavailable");
    expect(onlineLines(r, { online: true })).toEqual([
      onlineDidNotRun("no online verifier: @nearai/inference-sdk is not available"),
    ]);
    expect(onlineLines(r, { online: true, onlineNotRun: "the reason the CLI knows" })).toEqual([
      "online: O1 and O2 did not run (the reason the CLI knows)",
    ]);
    expect(renderReport(r, { online: true })).not.toMatch(LEGEND);
  });

  it("print no legend when O1 fails: the FAIL row of check e is the result", async () => {
    const debug: OnlineAttestationVerifier = {
      ...genuine,
      verifyQuote: async () => ({ ...(await genuine.verifyQuote("")), debugEnabled: true }),
    };
    const r = await online(ledgerOf(attested(true)), debug);
    expect(r.checks[4]).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("O1 failed"),
    });
    expect(onlineLines(r, { online: true })).toEqual([]);
    const text = renderReport(r, { online: true });
    expect(text).not.toMatch(LEGEND);
    expect(text).not.toContain("did not run");
  });

  it("print the clock hint, and no legend, when O2 fails with not_yet_valid (a clock behind NVIDIA's)", async () => {
    const early: OnlineAttestationVerifier = {
      ...genuine,
      verifyGpu: async () => {
        throw new Error(
          "[gpu.jwt_verification_failed] NVIDIA JWT verification failed: not_yet_valid",
        );
      },
    };
    const r = await online(ledgerOf(attested(true)), early);
    expect(r.checks[4]).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("not_yet_valid"),
    });
    expect(onlineLines(r, { online: true })).toEqual([CLOCK_HINT]);
    expect(CLOCK_HINT).toMatch(/^online hint: .*clock.*run --online again$/);
    const text = renderReport(r, { online: true });
    expect(text).toContain(`\n${CLOCK_HINT}\n`);
    expect(text).not.toMatch(LEGEND);
    expect(text).toContain("RESULT: FAIL");
  });

  it("print no clock hint for another online failure", async () => {
    const bad: OnlineAttestationVerifier = {
      ...genuine,
      verifyGpu: async () => {
        throw new Error("[gpu.jwt_verification_failed] NVIDIA JWT verification failed: expired");
      },
    };
    const r = await online(ledgerOf(attested(true)), bad);
    expect(r.checks[4]?.status).toBe("fail");
    expect(onlineLines(r, { online: true })).toEqual([]);
  });

  it("print no legend when check e failed offline, even if O1 and O2 then ran", async () => {
    const r = await online(ledgerOf(attested(true)), genuine, report({ e: "fail" }));
    expect(r.checks[4]?.detail).toContain("online: 1 DCAP-genuine TDX quotes");
    expect(onlineLines(r, { online: true })).toEqual([]);
  });

  it("print nothing without --online, and no legend for a detail that does not report an online run", async () => {
    const r = await online(ledgerOf(attested(true)), genuine);
    expect(onlineLines(r)).toEqual([]);
    expect(renderReport(r)).not.toMatch(/^online/m);
    expect(onlineLines(report(), { online: true })).toEqual([
      "online: O1 and O2 did not run (check e does not report an online run)",
    ]);
    expect(onlineLines(report({}, { checks: [] }), { online: true })).toEqual([
      "online: O1 and O2 did not run (the report has no check e)",
    ]);
  });
});

// ---------- text from a snapshot or the chain, printed safely (T16 follow-up) ----------

const ESC = "\u001b";

describe("printable", () => {
  it("replaces ANSI sequences and control, format and separator characters with U+FFFD", () => {
    expect(printable(`ok${ESC}[32mgreen${ESC}[0m`)).toBe(`ok${REMOVED}green${REMOVED}`);
    expect(printable(`${ESC}]0;title\u0007after`)).toBe(`${REMOVED}after`);
    expect(printable("a\nb\rc\td")).toBe(`a${REMOVED}b${REMOVED}c${REMOVED}d`);
    expect(printable("C1 \u0085 \u009b here")).toBe(`C1 ${REMOVED} ${REMOVED} here`);
    expect(printable("evil‮txt.exe ⁦x⁩")).toBe(`evil${REMOVED}txt.exe ${REMOVED}x${REMOVED}`);
    expect(printable("zero​width﻿")).toBe(`zero${REMOVED}width${REMOVED}`);
    expect(printable("line para ")).toBe(`line${REMOVED}para${REMOVED}`);
    expect(printable(`lone ${ESC} escape`)).toBe(`lone ${REMOVED} escape`);
  });

  it("leaves ordinary text alone, punctuation and non-ASCII letters included", () => {
    const plain =
      "2 attested decisions pass A1–A7; Đà Nẵng … WITHDRAW_TO:0x1111 [first broken seq 2]";
    expect(printable(plain)).toBe(plain);
  });
});

describe("renderReport on crafted text", () => {
  it("prints a detail with a newline and ANSI escapes on one line, with placeholders, so no fake RESULT appears", () => {
    const r = report({ c: "fail" });
    const c = r.checks[2] as CheckResult;
    c.detail = `bad anchor${ESC}[2K\r\nRESULT: PASS${ESC}[0m‮`;
    const text = renderReport(r);
    expect(text).toContain(
      `c  check-c                FAIL      bad anchor${REMOVED}${REMOVED}${REMOVED}RESULT: PASS${REMOVED}${REMOVED}\n`,
    );
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("\r");
    expect(text).not.toContain("‮");
    expect(text.match(/^RESULT: /gm)).toEqual(["RESULT: "]);
    expect(text).toMatch(/\nRESULT: FAIL\n$/);
  });

  it("removes controls from the header, the offline time, the hint and a reason too", () => {
    const r = report(
      { h: "unproven" },
      {
        vault: `x.near\n${ESC}[32mRESULT: PASS`,
        network: "testnet\r" as never,
        unproven: [{ check: "h", spend_id: 3, reason: `approver_tx\n${ESC}[1m` as never }],
      },
    );
    const text = renderReport(r, { offline: { takenAt: `2026-11-05\n${ESC}[32mRESULT: PASS` } });
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("\r");
    expect(text.match(/^RESULT: /gm)).toEqual(["RESULT: "]);
    expect(text).toContain(
      `Probarion verify: x.near${REMOVED}${REMOVED}RESULT: PASS (testnet${REMOVED})\n`,
    );
    expect(text).toContain(
      `snapshot taken 2026-11-05${REMOVED}${REMOVED}RESULT: PASS: its chain data`,
    );
    expect(text).toContain(`--vault x.near${REMOVED}${REMOVED}RESULT: PASS --snapshot <file>`);
    expect(text).toContain(`(approver_tx${REMOVED}${REMOVED}): see the check's detail`);
  });

  it("says 'snapshot time not recorded' when the offline time is null", () => {
    const text = renderReport(report(), { offline: { takenAt: null } });
    expect(text).toContain(
      "\nsnapshot time not recorded: its chain data is the file's and was not read from the chain again\n",
    );
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
  });
});
