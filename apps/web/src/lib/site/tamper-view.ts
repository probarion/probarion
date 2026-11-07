// What the ledger test shows for a result. The client component imports this on first load, so it holds words and
// branching only: the verifier and the fixture stay behind the dynamic import() in TamperTest.
import type { TamperCheck, TamperResult } from "./tamper";

const STATUS_WORD: Readonly<Record<TamperCheck["status"], string>> = {
  pass: "pass",
  fail: "fail",
  skip: "skipped",
  unproven: "not proven",
};

/** One sentence, so that a live region reads it whole. */
export function resultSummary(result: Omit<TamperResult, "ok">, firstBroken: string): string {
  const counts = `${result.passed} passed, ${result.failed} failed, ${result.unproven} unproven`;
  return result.firstBroken === null ? counts : `${counts}. ${firstBroken} ${result.firstBroken}`;
}

/** A body edited after signing, in the words of check a or b (packages/core/src/verify.ts). */
const CHANGED = /^entry (\d+) body_hash does not recompute from its body\b/;
/** Entries cut from the end, in the words of check c. */
const CUT = /covers (\d+) entries but the ledger has (\d+): entry \d+ and later are missing$/;

/**
 * The verdict in plain words, beside PASS or FAIL. It reads the verifier's result, not the button pressed, and names a
 * cause and an entry only when the verifier's own words name them: an entry whose body no longer gives the hash its
 * signature covers (check a or b), or one entry cut from the end that an anchor still counts (check c alone). Any other
 * result gets the counts. The verifier's own words go in the disclosure below the checks.
 */
export function plainVerdict(result: Omit<TamperResult, "ok">, firstBroken: string): string {
  const failed = new Map(
    result.checks.filter((c) => c.status === "fail").map((c) => [c.id, c.detail]),
  );
  const all = result.checks.length;
  if (failed.size === 0 && result.unproven === 0 && all > 0 && result.passed === all) {
    return `All ${all} offline checks pass.`;
  }
  const changed = CHANGED.exec(failed.get("a") ?? "") ?? CHANGED.exec(failed.get("b") ?? "");
  if (changed !== null) {
    return `Entry ${changed[1]} was changed after it was signed, so its signature no longer matches.`;
  }
  const cut = failed.size === 1 ? CUT.exec(failed.get("c") ?? "") : null;
  if (cut !== null && Number(cut[1]) === Number(cut[2]) + 1) {
    return `Entry ${cut[2]} is missing, but the vault anchored a count that includes it.`;
  }
  return resultSummary(result, firstBroken);
}

/**
 * The next step follows a run the verifier failed, while that run is what the panel shows: not at rest, not after
 * Restore, not for a result that is only unproven, and not once a later press did not finish.
 */
export function offersNext(
  shown: { live: boolean; result: Pick<TamperResult, "failed"> },
  notRun: boolean,
): boolean {
  return shown.live && shown.result.failed > 0 && !notRun;
}

/** The disclosure that holds the counts and, for each check that did not pass, the verifier's own words. */
export const VERIFIER_DETAIL = "Verifier detail";

/**
 * The left card's status line. It carries the verdict word because on a phone the table sits between the buttons and
 * the verdict panel. Only that panel is a live region, so a screen reader hears the verdict once.
 */
export function statusLine(ok: boolean, what: string): string {
  return `${ok ? "PASS" : "FAIL"}. ${what}.`;
}

/** The same line when a press did not produce a result: the word beside the button must not be the old verdict. */
export const notRunLine = (notRun: string): string => `${notRun}.`;

/**
 * The parts of a passing check's detail that say something was not done, such as "2 entries after the last anchored
 * count (3) are not chain-attested". They are the verifier's own words. A part that starts with "0 entries" leaves
 * nothing undone, and the rest of a passing detail repeats that the check passed.
 */
export function passCaveat(detail: string): string {
  return detail
    .split(/;\s*/)
    .filter((part) => /\bnot\b/i.test(part) && !/^0 entries\b/.test(part))
    .join("; ");
}

/** What check e leaves undone in a browser. The verifier's own words name a CLI flag and ids the page does not define. */
const ATTESTATION_CAVEAT = "The hardware quote and the request are not checked here.";

export interface CheckView {
  word: string;
  bad: boolean;
  /** The verifier's own words on why this check did not pass. */
  why: string;
  caveat: string;
}

/** A check the verifier did not return is not a pass. */
export function checkView(check: TamperCheck | undefined): CheckView {
  if (check === undefined) return { word: "not run", bad: true, why: "", caveat: "" };
  if (check.status === "pass") {
    const caveat = check.id === "e" ? ATTESTATION_CAVEAT : passCaveat(check.detail);
    return { word: STATUS_WORD.pass, bad: false, why: "", caveat };
  }
  return { word: STATUS_WORD[check.status], bad: true, why: check.detail, caveat: "" };
}

export type VerifierRun =
  | { outcome: "done"; result: TamperResult }
  | { outcome: "load_failed" }
  | { outcome: "run_failed" };

/** Loads the verifier, then runs it. A failed load can be tried again; a failed run is the verifier's own. */
export async function runVerifier<Edit>(
  load: () => Promise<(edit: Edit) => Promise<TamperResult>>,
  edit: Edit,
): Promise<VerifierRun> {
  let verify: (edit: Edit) => Promise<TamperResult>;
  try {
    verify = await load();
  } catch {
    return { outcome: "load_failed" };
  }
  try {
    return { outcome: "done", result: await verify(edit) };
  } catch {
    return { outcome: "run_failed" };
  }
}
