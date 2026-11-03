// renderReport and the verify exit code, on hand-made reports (the CLI tests run them on real ones).
import type { CheckResult, VerifyReport } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { renderReport, verifyExitCode, verifyOutcome } from "../src/report.js";

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

  it("with online, says what O1 shows and that the measurement is not pinned", () => {
    const text = renderReport(report(), { online: true });
    expect(text).toContain(
      "online: O1: DCAP-genuine TDX quote bound to this request; measurement not pinned (O1b deferred)",
    );
    expect(text).not.toMatch(/verified TEE|TEE verified|attested model verified/i);
  });
});
