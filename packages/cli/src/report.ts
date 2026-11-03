import {
  type CheckResult,
  firstBrokenSeq,
  type UnprovenBurn,
  type VerifyReport,
} from "@probarion/core";

/** What a report comes to, and the exit code of `probarion verify` for it. */
export type VerifyOutcome = "pass" | "fail" | "unproven";

/** `probarion verify` exit codes: 0 every check passes, 1 a check fails (a fail always wins), 2 unproven. */
export const VERIFY_EXIT_CODES: Readonly<Record<VerifyOutcome, number>> = {
  pass: 0,
  fail: 1,
  unproven: 2,
};

/**
 * A fail always wins over unproven. A report that is not ok but names neither (it cannot come from `runChecks`)
 * and a report without checks count as a fail: nothing short of every check passing is a pass.
 */
export function verifyOutcome(report: VerifyReport): VerifyOutcome {
  const checks: readonly CheckResult[] = Array.isArray(report.checks) ? report.checks : [];
  if (checks.length === 0 || checks.some((c) => c.status === "fail")) return "fail";
  const unproven = Array.isArray(report.unproven) ? report.unproven : [];
  if (checks.some((c) => c.status === "unproven") || unproven.length > 0) return "unproven";
  return report.ok === true ? "pass" : "fail";
}

export function verifyExitCode(report: VerifyReport): number {
  return VERIFY_EXIT_CODES[verifyOutcome(report)];
}

/** What to do about an unproven burn, by reason (ICR-12, ICR-13). */
export const UNPROVEN_HINTS: Readonly<Record<UnprovenBurn["reason"], string>> = {
  tx_unavailable: "re-run, or add --archival-rpc",
  approver_tx: "supply the burn tx with --burn-tx or --proof",
  not_recorded: "supply the burn tx with --burn-tx or --proof",
  pre_ledger_no_tx: "supply the burn tx with --burn-tx or --proof",
};

export interface RenderOptions {
  /** The report is of a saved snapshot (`--offline`): its burns were looked up when the snapshot was taken. */
  offline?: boolean;
  /** O1/O2 ran (`--online`): say what O1 shows, and what it does not. */
  online?: boolean;
}

const STATUS_WIDTH = "UNPROVEN".length;

function unprovenLines(report: VerifyReport, offline: boolean): string[] {
  const byReason = new Map<string, number[]>();
  for (const u of Array.isArray(report.unproven) ? report.unproven : []) {
    const ids = byReason.get(u.reason) ?? [];
    ids.push(u.spend_id);
    byReason.set(u.reason, ids);
  }
  const lines: string[] = [];
  for (const [reason, ids] of byReason) {
    const hint =
      UNPROVEN_HINTS[reason as UnprovenBurn["reason"]] ??
      "see the check's detail for what is missing";
    // A saved snapshot holds what was found when it was taken: the flags apply to taking it again.
    const when = offline
      ? ` (when the snapshot is taken: probarion verify --vault ${report.vault} --snapshot <file>)`
      : "";
    const spends = `${ids.length === 1 ? "spend" : "spends"} ${ids.join(", ")}`;
    lines.push(`   unproven: ${spends} (${reason}): ${hint}${when}`);
  }
  return lines;
}

/**
 * The human report: one row per check (PASS, FAIL, UNPROVEN or SKIP, with its detail), the unproven spends with
 * their reason and a hint under the row that could not prove them, a count line and the result.
 */
export function renderReport(report: VerifyReport, opts: RenderOptions = {}): string {
  const lines = [
    `Probarion verify: ${report.vault} (${report.network})`,
    `entries ${report.entries}, anchors ${report.anchors}, generated ${report.generated_at}`,
    "",
  ];
  const checks: readonly CheckResult[] = Array.isArray(report.checks) ? report.checks : [];
  const count = { pass: 0, fail: 0, unproven: 0, skip: 0 };
  for (const check of checks) {
    if (check.status in count) count[check.status] += 1;
    const seq =
      check.status === "fail" && typeof check.firstBrokenSeq === "number"
        ? ` [first broken seq ${check.firstBrokenSeq}]`
        : "";
    const status = String(check.status).toUpperCase().padEnd(STATUS_WIDTH);
    lines.push(`${check.id}  ${check.name.padEnd(22)} ${status}  ${check.detail}${seq}`);
    if (check.status === "unproven") lines.push(...unprovenLines(report, opts.offline === true));
  }
  lines.push("");
  if (opts.online === true) {
    lines.push(
      "online: O1: DCAP-genuine TDX quote bound to this request; measurement not pinned (O1b deferred), so it does not show which image the TD runs. O2: the GPU payload carries the request nonce and NVIDIA NRAS verified it. Check e says how many ran.",
    );
  }
  const skipped = count.skip > 0 ? `, ${count.skip} skipped` : "";
  lines.push(`${count.pass} passed, ${count.fail} failed, ${count.unproven} unproven${skipped}`);
  const outcome = verifyOutcome(report);
  if (outcome === "pass") {
    lines.push("RESULT: PASS");
  } else if (outcome === "unproven") {
    lines.push("RESULT: UNPROVEN (no check failed; what the UNPROVEN rows name is not proven)");
  } else {
    const first = firstBrokenSeq(report);
    lines.push(`RESULT: FAIL${first === null ? "" : ` (first broken seq ${first})`}`);
  }
  return `${lines.join("\n")}\n`;
}
