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
  /**
   * The report is of a saved snapshot (`--offline`) taken at `takenAt`: its chain data is the file's and was not
   * read from the chain again, and the flags that shape a snapshot apply to taking it again.
   */
  offline?: { takenAt: string | null };
  /** `--online` was asked for: say whether O1 and O2 ran, and what they check when they did. */
  online?: boolean;
  /** Why O1 and O2 did not run, when the caller knows it (no online verifier could be loaded). */
  onlineNotRun?: string;
}

/**
 * The SDK's check e detail when O1 and O2 ran on every attested decision and none failed (`applyOnlineChecks`).
 * When this text is not there, nothing here says that O1 or O2 ran.
 */
const ONLINE_RAN =
  /online: (\d+) DCAP-genuine TDX quotes bound to this request \(O1: [^)]*\) and (\d+) GPU payloads bound to the request nonce and verified by NRAS \(O2\)/;

/** What O1 checks. A legend, printed only when O1 ran on at least one quote and check e did not fail. */
export const O1_LEGEND =
  "online legend: O1 checks that a TDX quote is DCAP-genuine (Intel DCAP; debug off, an accepted TCB status) and bound to this request; measurement not pinned (O1b deferred), so O1 does not show which image the TD runs";

/** What O2 checks. A legend, printed only when O2 ran on at least one GPU payload and check e did not fail. */
export const O2_LEGEND =
  "online legend: O2 checks that a GPU payload carries the request nonce and that NVIDIA NRAS verifies it";

export function onlineDidNotRun(reason: string): string {
  return `online: O1 and O2 did not run (${reason})`;
}

/**
 * The online failure that says more about this computer than about the decision: NVIDIA's NRAS token was issued a
 * moment ago by NVIDIA's clock, and @nearai/inference-sdk checks its `nbf` and `iat` with no tolerance, so a local clock
 * a few seconds behind turns a fresh, valid token into "not_yet_valid".
 *
 * Anchored to the start of the detail and to the SDK's exact message: applyOnlineChecks puts its own failure first
 * ("online: O1/O2 failed at entry N: <message>; offline: ..."), while the offline part can quote the ledger (a
 * `decided_by`, a vault name), so an unanchored match would let a ledger print the hint for another failure.
 */
const CLOCK_BEHIND =
  /^online: O1\/O2 failed at entry \d+: \[gpu\.jwt_verification_failed\] NVIDIA JWT verification failed: not_yet_valid(?:;|$)/;

/** The hint under a check e that failed online with `not_yet_valid`. It is a hint, not a result: e stays FAIL. */
export const CLOCK_HINT =
  "online hint: NVIDIA's token was not yet valid by this computer's clock, which may be a few seconds behind; sync the clock (on Windows: Settings, Time, Sync now) and run --online again";

/**
 * The lines `--online` adds under the rows: a legend for what ran, or why O1 and O2 did not run. They are never a
 * result of their own: check e is the result, and a failed check e gets no legend (only the clock hint, when O2's
 * token was not yet valid by this computer's clock).
 */
export function onlineLines(report: VerifyReport, opts: RenderOptions = {}): string[] {
  if (opts.online !== true) return [];
  if (opts.onlineNotRun !== undefined) return [onlineDidNotRun(opts.onlineNotRun)];
  const checks: readonly CheckResult[] = Array.isArray(report.checks) ? report.checks : [];
  const e = checks.find((c) => c.id === "e");
  if (e === undefined) return [onlineDidNotRun("the report has no check e")];
  if (e.detail.includes("online: unavailable")) {
    return [onlineDidNotRun("no online verifier: @nearai/inference-sdk is not available")];
  }
  if (e.status === "fail") return CLOCK_BEHIND.test(e.detail) ? [CLOCK_HINT] : [];
  const ran = ONLINE_RAN.exec(e.detail);
  if (ran === null) return [onlineDidNotRun("check e does not report an online run")];
  if (Number(ran[1]) === 0) return [onlineDidNotRun("no attested decision in this ledger")];
  return [
    O1_LEGEND,
    Number(ran[2]) > 0
      ? O2_LEGEND
      : "online: O2 did not run (no attested decision carries a GPU payload)",
  ];
}

const STATUS_WIDTH = "UNPROVEN".length;
const OFFLINE_O1 = "(run --online for O1)";

/** What stands where text was removed from the human output, so that a reader can tell that something was. */
export const REMOVED = "\u{FFFD}";

/** A whole ANSI escape sequence: CSI (`ESC [ … final`) or OSC (`ESC ] … BEL` or `ESC ] … ESC \`). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC and BEL is the point of this pattern
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g;

/**
 * Control and format characters (C0, C1, ESC, bidi overrides, zero-width marks) and line or paragraph separators:
 * anything that can move the cursor, recolour, reorder or split what the terminal shows.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Text that comes from a snapshot or the chain, made safe to print: each ANSI sequence and each control, format
 * or separator character becomes `REMOVED` (U+FFFD). A crafted snapshot cannot add a line (a fake `RESULT: PASS`),
 * recolour one or reorder it. `--json` prints the data as it is: JSON escapes it.
 */
export function printable(text: string): string {
  return String(text).replace(ANSI_SEQUENCE, REMOVED).replace(UNPRINTABLE, REMOVED);
}

function unprovenLines(report: VerifyReport, check: CheckResult, opts: RenderOptions): string[] {
  const byReason = new Map<string, number[]>();
  for (const u of Array.isArray(report.unproven) ? report.unproven : []) {
    if (u.check !== check.id) continue;
    const ids = byReason.get(u.reason) ?? [];
    ids.push(u.spend_id);
    byReason.set(u.reason, ids);
  }
  const lines: string[] = [];
  for (const [reason, ids] of byReason) {
    const hint =
      UNPROVEN_HINTS[reason as UnprovenBurn["reason"]] ??
      "see the check's detail for what is missing";
    const when =
      opts.offline === undefined
        ? ""
        : ` (when the snapshot is taken: probarion verify --network ${report.network} --vault ${report.vault} --snapshot <file>)`;
    const spends = `${ids.length === 1 ? "spend" : "spends"} ${ids.join(", ")}`;
    lines.push(`   unproven: ${spends} (${reason}): ${hint}${when}`);
  }
  return lines;
}

function shownDetail(check: CheckResult, opts: RenderOptions): string {
  // --online is refused with --offline: running O1 means verifying live again.
  if (opts.offline !== undefined && check.id === "e") {
    return check.detail.replace(
      OFFLINE_O1,
      "(run --online for O1; re-take the snapshot live with --online)",
    );
  }
  return check.detail;
}

/**
 * The human report: one row per check (PASS, FAIL, UNPROVEN or SKIP, with its detail), the unproven spends with
 * their reason and a hint under the row that could not prove them, what `--online` ran, a count line and the result.
 */
export function renderReport(report: VerifyReport, opts: RenderOptions = {}): string {
  const lines = [
    `Probarion verify: ${report.vault} (${report.network})`,
    `entries ${report.entries}, anchors ${report.anchors}, generated ${report.generated_at}`,
  ];
  if (opts.offline !== undefined) {
    const when =
      opts.offline.takenAt === null
        ? "snapshot time not recorded"
        : `snapshot taken ${opts.offline.takenAt}`;
    lines.push(`${when}: its chain data is the file's and was not read from the chain again`);
  }
  lines.push("");
  const checks: readonly CheckResult[] = Array.isArray(report.checks) ? report.checks : [];
  const count = { pass: 0, fail: 0, unproven: 0, skip: 0 };
  for (const check of checks) {
    if (check.status in count) count[check.status] += 1;
    const seq =
      check.status === "fail" && typeof check.firstBrokenSeq === "number"
        ? ` [first broken seq ${check.firstBrokenSeq}]`
        : "";
    const status = String(check.status).toUpperCase().padEnd(STATUS_WIDTH);
    lines.push(
      `${check.id}  ${check.name.padEnd(22)} ${status}  ${shownDetail(check, opts)}${seq}`,
    );
    if (check.status === "unproven") lines.push(...unprovenLines(report, check, opts));
  }
  lines.push("", ...onlineLines(report, opts));
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
  // Every line, the snapshot's and the chain's strings among them: one line each, as the reader sees it.
  return `${lines.map(printable).join("\n")}\n`;
}
