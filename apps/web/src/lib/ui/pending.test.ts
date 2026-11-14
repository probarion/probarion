import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTION_READ_TIMEOUT_MS,
  CONFIRM_HINT_MS,
  consoleTimedOut,
  EASE,
  ELAPSED_FROM_MS,
  FADE_MS,
  formatElapsed,
  JOB_WAIT_MS,
  MIN_SHOW_MS,
  POLL_EVERY_MS,
  SAVE_UNCLEAR,
  SHOW_DELAY_MS,
  SIGN_IN_CLOSED,
  SIGN_IN_LABELS,
  SIGN_IN_NOT_READY_LABEL,
  SIGN_IN_PHASE_LABEL,
  SIGN_IN_TIMED_OUT,
  SIGN_IN_TIMEOUT_MS,
  SIGN_IN_WALLET_LINE,
  SLOW_HINT,
  serverTimedOut,
  slowHint,
  TEE_TIMEOUT_MS,
  TRY_AGAIN_BUSY,
  TRY_AGAIN_LABEL,
  TX_PHASE_LABEL,
  TX_PHASE_LABELS,
  TX_PHASE_LINE,
  WAIT,
  WALLET_HINT_MS,
  type WaitKind,
} from "./pending";

const KINDS = Object.keys(WAIT) as WaitKind[];

/** Every sentence and label a wait can show. */
function allCopy(): string[] {
  return [
    ...Object.values(TX_PHASE_LABEL),
    ...Object.values(TX_PHASE_LINE).filter((s): s is string => s !== null),
    ...Object.values(SLOW_HINT).flatMap((h) => (h ? [h.lead, h.rest ?? ""] : [])),
    ...SIGN_IN_LABELS,
    SIGN_IN_WALLET_LINE,
    SIGN_IN_TIMED_OUT,
    SIGN_IN_CLOSED,
    TRY_AGAIN_LABEL,
    TRY_AGAIN_BUSY,
    consoleTimedOut(),
    serverTimedOut(20_000),
    SAVE_UNCLEAR,
  ].filter(Boolean);
}

/** The labels a busy control shows: 1 to 4 words, ending in the ellipsis character. */
function allLabels(): string[] {
  return [...TX_PHASE_LABELS, ...SIGN_IN_LABELS, TRY_AGAIN_BUSY];
}

describe("the timing tokens", () => {
  it("are the spec's numbers", () => {
    expect([SHOW_DELAY_MS, MIN_SHOW_MS, FADE_MS, ELAPSED_FROM_MS]).toEqual([200, 400, 150, 5000]);
    expect([WALLET_HINT_MS, CONFIRM_HINT_MS, POLL_EVERY_MS]).toEqual([20_000, 15_000, 5000]);
  });

  // The 200 ms gate and the 150 ms fade are CSS, never a JS timer: what CSS holds must be these numbers.
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const css = read("../../app/globals.css");
  /** A CSS custom property's or rule's value, by the text that leads to it. */
  const value = (from: RegExp) => {
    const m = css.match(from);
    if (!m?.[1]) throw new Error(`not in globals.css: ${from}`);
    return m[1];
  };

  it("are the delays and the fade globals.css draws with, reduced motion included", () => {
    const pendingIn = [...css.matchAll(/--animate-pending-in:([^;]*);/g)].map((m) => m[1] ?? "");
    expect(pendingIn).toHaveLength(2);
    expect(pendingIn[0]).toContain(`${FADE_MS}ms ${EASE} ${SHOW_DELAY_MS}ms`);
    // Reduced motion keeps the gate: it prevents a flash and is not motion.
    expect(pendingIn[1]).toContain(`1ms linear ${SHOW_DELAY_MS}ms`);
    expect(value(/\.busy-echo \{\s*animation:([^;]*);/)).toContain(`${SHOW_DELAY_MS}ms`);
    expect(value(/--animate-route-bar:([^;]*);/)).toContain(`${EASE} ${SHOW_DELAY_MS}ms`);
  });

  it("are the delays and the fade of the Tailwind classes that dim a blocked button or a last answer", () => {
    const delay = `delay-${SHOW_DELAY_MS}`;
    expect(read("../../components/ui.tsx")).toContain(`aria-disabled:${delay}`);
    const look = read("../../components/console/form-look.ts");
    expect(look).toContain(`aria-disabled:${delay}`);
    expect(look).toContain(`[&>div]:${delay} [&>div]:duration-${FADE_MS}`);
  });
});

describe("formatElapsed", () => {
  it("writes m:ss, whole seconds rounded down", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(999)).toBe("0:00");
    expect(formatElapsed(7_000)).toBe("0:07");
    expect(formatElapsed(59_999)).toBe("0:59");
    expect(formatElapsed(60_000)).toBe("1:00");
    expect(formatElapsed(72_400)).toBe("1:12");
    expect(formatElapsed(10 * 60_000 + 5_000)).toBe("10:05");
  });

  it("reads a clock that has not started (or a time from the future) as 0:00", () => {
    expect(formatElapsed(-1_500)).toBe("0:00");
  });
});

describe("each kind of wait", () => {
  it("never aborts a write, a job, the wallet or the chain confirm, and retries reads only", () => {
    for (const kind of ["action-write", "job", "wallet", "confirm"] as const) {
      expect(WAIT[kind].timeoutMs, kind).toBeNull();
      expect(WAIT[kind].autoRetry, kind).toBe(false);
    }
    expect(KINDS.filter((k) => WAIT[k].autoRetry)).toEqual(["read"]);
    expect(WAIT["action-read"].timeoutMs).toBe(ACTION_READ_TIMEOUT_MS);
    expect(ACTION_READ_TIMEOUT_MS).toBe(20_000);
  });

  it("stops waiting on a job at the job's own deadline, after its slow mark, and on the TEE check at 35 s", () => {
    // The invoice route and the Canary's run up to 90 s, the client waits 5 s more; the faucet's mint 25 s.
    expect(JOB_WAIT_MS).toEqual({ invoice: 95_000, canary: 95_000, faucet: 25_000 });
    for (const [job, ms] of Object.entries(JOB_WAIT_MS)) {
      expect(ms, job).toBeGreaterThan(ELAPSED_FROM_MS);
    }
    expect(JOB_WAIT_MS.invoice).toBeGreaterThan(WAIT.job.slowMs ?? Infinity);
    expect(TEE_TIMEOUT_MS).toBe(35_000);
  });

  it("has its slow mark before its timeout, so the hint shows while there is still time", () => {
    for (const kind of KINDS) {
      const { timeoutMs, slowMs } = WAIT[kind];
      if (timeoutMs !== null && slowMs !== null) expect(slowMs, kind).toBeLessThan(timeoutMs);
    }
  });
});

describe("slowHint", () => {
  const marks: [WaitKind, number][] = [
    ["read", 6_000],
    ["api", 4_000],
    ["action-read", 5_000],
    ["action-write", 5_000],
    ["job", 30_000],
    ["wallet", WALLET_HINT_MS],
    ["confirm", CONFIRM_HINT_MS],
  ];

  it.each(marks)("shows %s's hint from %i ms, and nothing a moment before", (kind, at) => {
    expect(slowHint(kind, at - 1)).toBeNull();
    expect(slowHint(kind, at)).toBe(SLOW_HINT[kind]);
    expect(slowHint(kind, at * 3)).toBe(SLOW_HINT[kind]);
  });

  it("covers every kind but the poll, which shows when it last checked instead", () => {
    expect(marks.map(([k]) => k).sort()).toEqual(KINDS.filter((k) => k !== "poll").sort());
    expect(slowHint("poll", 10 * 60_000)).toBeNull();
    expect(SLOW_HINT.poll).toBeNull();
  });

  it("shows an API route's hint at half of the timeout it is given", () => {
    expect(slowHint("api", 9_999, 20_000)).toBeNull();
    expect(slowHint("api", 10_000, 20_000)).toBe(SLOW_HINT.api);
    expect(slowHint("api", 17_000, 35_000)).toBeNull();
    // Another kind keeps its own mark whatever it is passed.
    expect(slowHint("action-read", 5_000, 60_000)).toBe(SLOW_HINT["action-read"]);
  });

  it("says what is happening and what not to do, the wallet's and the chain's as the spec words them", () => {
    expect(SLOW_HINT.wallet).toEqual({
      lead: "Still waiting for your wallet",
      rest: "If you closed its window, check your wallet's activity before you sign again.",
    });
    expect(SLOW_HINT.confirm).toEqual({
      lead: "NEAR is slow to confirm",
      rest: "Do not sign again: this button is still checking the same transaction.",
    });
    expect(SLOW_HINT["action-read"]).toEqual({
      lead: "Still reading the chain",
      rest: "The console finishes one request at a time.",
    });
    expect(SLOW_HINT["action-write"]?.lead).toBe("Still saving");
    // The read's hint is one short phrase with no clock: the next node is tried at once.
    expect(SLOW_HINT.read).toEqual({ lead: "Trying another NEAR node…" });
  });
});

describe("the phases", () => {
  it("names who is acting in each step of a wallet transaction", () => {
    expect(TX_PHASE_LABEL).toEqual({
      prepare: "Preparing…",
      wallet: "Check your wallet…",
      confirm: "Confirming on NEAR…",
      finish: "Finishing…",
      refresh: "Updating the page…",
    });
    expect(TX_PHASE_LABELS).toEqual(Object.values(TX_PHASE_LABEL));
    expect(TX_PHASE_LINE.wallet).toBe("Approve or reject it in your wallet's window or tab.");
    expect(TX_PHASE_LINE.confirm).toBe("Your wallet sent it. Reading the result from NEAR.");
    expect([TX_PHASE_LINE.finish, TX_PHASE_LINE.refresh]).toEqual([null, null]);
  });

  it("keeps sign-in's labels, the e2e test's Loading wallets… among them", () => {
    expect(SIGN_IN_NOT_READY_LABEL).toBe("Loading wallets…");
    expect(SIGN_IN_NOT_READY_LABEL).toMatch(/Sign in with NEAR wallet|Loading wallets/);
    expect(SIGN_IN_PHASE_LABEL).toEqual({
      wallet: "Check your wallet…",
      verify: "Checking your signature…",
      open: "Opening your console…",
    });
    expect(SIGN_IN_TIMED_OUT).toBe(
      `The server did not answer in ${SIGN_IN_TIMEOUT_MS / 1000} s. You are not signed in. Try again.`,
    );
    expect(SIGN_IN_TIMEOUT_MS).toBe(15_000);
  });
});

describe("the outcomes", () => {
  it("say what failed, and that nothing changed only where the path proves it", () => {
    // A server action the console stopped waiting for runs on and writes the console's copy, so it may still finish.
    expect(consoleTimedOut()).toBe(
      "The console did not answer in 20 s. It may still finish: reload the page to see, or try again.",
    );
    expect(consoleTimedOut()).not.toMatch(/Nothing was|chain/);
    // One of our API routes that only reads.
    expect(serverTimedOut(35_000)).toBe(
      "The server did not answer in 35 s. Nothing was changed. Try again.",
    );
    // A save that may have run says where to look and offers no Try again.
    expect(SAVE_UNCLEAR).not.toMatch(/Try again|Nothing was/);
  });
});

describe("the copy", () => {
  it("has no dash used as punctuation: no em, en, figure or bar dash, no spaced hyphen", () => {
    for (const s of allCopy()) expect(s, s).not.toMatch(/[‒-―−]|\s-\s/);
  });

  it("makes no claim the rules ban", () => {
    for (const s of allCopy()) {
      expect(s, s).not.toMatch(/\b(?:first|only|never|unhackable|unbreakable|guaranteed)\b/i);
      expect(s, s).not.toMatch(/!|\.\.\.|please wait|processing/i);
    }
  });

  it("ends every busy label in the ellipsis character, in 1 to 4 words, and every sentence in a full stop", () => {
    for (const label of allLabels()) {
      expect(label, label).toMatch(/[^.]…$/);
      expect(label.split(/\s+/).length, label).toBeLessThanOrEqual(4);
    }
    for (const line of [
      ...Object.values(TX_PHASE_LINE).filter((s): s is string => s !== null),
      SIGN_IN_WALLET_LINE,
      ...Object.values(SLOW_HINT).flatMap((h) => (h?.rest ? [h.rest] : [])),
    ]) {
      expect(line, line).toMatch(/\.$/);
    }
  });
});
