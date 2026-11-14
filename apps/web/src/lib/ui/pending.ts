// The loading system's timing and words: how long the screen stays still, how long each kind of wait may take, and
// what a wait says while it runs. Pure, so it is unit-tested without React. app/globals.css holds the same delays as
// CSS (the 200 ms gate and the 150 ms fade are animation-delay and duration there, never a JS timer), and
// components/pending draws them.

/** Nothing on screen changes for this long after a press: globals.css's 200 ms animation-delay. ARIA and label text change at once. */
export const SHOW_DELAY_MS = 200;
/**
 * Once shown, an indicator that replaces content stays at least this long, so it does not flicker. Used by
 * useDelayedFlag only (the live check's headline); it never holds a button label or a result back.
 */
export const MIN_SHOW_MS = 400;
/** Colour dims and fades. */
export const FADE_MS = 150;
/** The house entrance curve, as the site's CSS already uses it. */
export const EASE = "cubic-bezier(0.2, 0.7, 0.2, 1)";
/** A job with a budget shows its elapsed time (m:ss) from here. */
export const ELAPSED_FROM_MS = 5_000;
/** When a wallet step says it is still waiting. A wallet step has no timeout. */
export const WALLET_HINT_MS = 20_000;
/** When the chain confirm says NEAR is slow. */
export const CONFIRM_HINT_MS = 15_000;
/** How often a background watch asks again: top-up status, a payable in processing. */
export const POLL_EVERY_MS = 5_000;
/** How long the console waits on a read-only server action, with `within()`. It stops the waiting; the action runs on. */
export const ACTION_READ_TIMEOUT_MS = 20_000;

/**
 * The kinds of wait, each with its own end:
 * - `read`: a chain read from the browser (the live check, the payee check);
 * - `api`: one of our API routes that only reads (the 1Click quote, top-up status, the TEE check, a sample);
 * - `action-read` and `action-write`: a server action that reads, or one that saves;
 * - `job`: a long write with a budget (the invoice cycle, a Canary attempt, the faucet);
 * - `wallet`: the owner's wallet, asked to sign;
 * - `confirm`: NEAR confirming a transaction the wallet sent;
 * - `poll`: a background watch.
 */
export type WaitKind =
  | "read"
  | "api"
  | "action-read"
  | "action-write"
  | "job"
  | "wallet"
  | "confirm"
  | "poll";

export interface Wait {
  /** When the client stops waiting and says so. Null: it waits as long as it takes (a write, the wallet, the chain confirm). */
  timeoutMs: number | null;
  /** When the one slow hint shows. Null: none (a poll shows when it last checked instead). */
  slowMs: number | null;
  /** Whether the client asks again by itself: idempotent reads, never a write or a wallet step. */
  autoRetry: boolean;
}

/**
 * Each kind's timeout, slow mark and retry. An `api` route's timeout is its server cap plus 5 s and differs per route
 * (the quote 20 s, top-up status 8 s, the TEE check 35 s, a sample 10 s): the 8 s here is the status poll's, and its
 * slow mark is half of whichever timeout the caller passes to slowHint. A `job` is never aborted, so it has no timeout
 * here: the page stops waiting at the job's own deadline (JOB_WAIT_MS) and says where to check. The chain confirm is
 * bounded by the page's maxDuration (60 s), then the TxButton lock. A poll's failed request waits for the next tick.
 */
export const WAIT: Readonly<Record<WaitKind, Wait>> = {
  read: { timeoutMs: 8_000, slowMs: 6_000, autoRetry: true },
  api: { timeoutMs: 8_000, slowMs: 4_000, autoRetry: false },
  "action-read": { timeoutMs: ACTION_READ_TIMEOUT_MS, slowMs: 5_000, autoRetry: false },
  "action-write": { timeoutMs: null, slowMs: 5_000, autoRetry: false },
  job: { timeoutMs: null, slowMs: 30_000, autoRetry: false },
  wallet: { timeoutMs: null, slowMs: WALLET_HINT_MS, autoRetry: false },
  confirm: { timeoutMs: null, slowMs: CONFIRM_HINT_MS, autoRetry: false },
  poll: { timeoutMs: 8_000, slowMs: null, autoRetry: false },
};

/**
 * Where the page stops waiting on a long job (spec 4.2), which runs on: the invoice cycle and a Canary attempt (their
 * routes' 90 s plus 5 s) and the faucet's mint. The page then says where to look before trying again.
 */
export const JOB_WAIT_MS = { invoice: 95_000, canary: 95_000, faucet: 25_000 } as const;
/** The TEE check, a long read: the route's 30 s cap plus 5 s, then an error and Try again. */
export const TEE_TIMEOUT_MS = 35_000;

/** Elapsed time as m:ss ("0:07", "1:12"), whole seconds rounded down. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A slow hint, "Still {doing} (m:ss). {What not to do}.", in two halves: a view puts the clock between them in an
 * aria-hidden span (components/pending/status-line.tsx), so the region announces the hint once and not every second.
 * Without `rest` the hint is `lead` alone, with no clock.
 */
export interface SlowHint {
  lead: string;
  rest?: string;
}

const QUEUE = "The console finishes one request at a time.";

/** Each kind's one hint. A job that knows what not to do (do not upload it again) writes its own. */
export const SLOW_HINT: Readonly<Record<WaitKind, SlowHint | null>> = {
  read: { lead: "Trying another NEAR node…" },
  api: {
    lead: "Still waiting for the server",
    rest: "It is a read, so nothing changes while you wait.",
  },
  "action-read": { lead: "Still reading the chain", rest: QUEUE },
  "action-write": { lead: "Still saving", rest: QUEUE },
  job: {
    lead: "Still running",
    rest: "Do not start it again: the console is still working on it.",
  },
  wallet: {
    lead: "Still waiting for your wallet",
    rest: "If you closed its window, check your wallet's activity before you sign again.",
  },
  confirm: {
    lead: "NEAR is slow to confirm",
    rest: "Do not sign again: this button is still checking the same transaction.",
  },
  poll: null,
};

/**
 * The hint for a wait of `kind` that has run `elapsedMs`, or null before its slow mark (and always for a poll).
 * `timeoutMs` is an `api` route's own timeout: its hint shows at half of it.
 */
export function slowHint(kind: WaitKind, elapsedMs: number, timeoutMs?: number): SlowHint | null {
  const at = kind === "api" && timeoutMs !== undefined ? timeoutMs / 2 : WAIT[kind].slowMs;
  return at !== null && elapsedMs >= at ? SLOW_HINT[kind] : null;
}

// --- Wallet transactions (TxButton) --------------------------------------------------------------------------------

/** A wallet transaction's steps, each named by who is acting: the console, the wallet, NEAR, then the page. */
export type TxPhase = "prepare" | "wallet" | "confirm" | "finish" | "refresh";

/** The button's label in each phase. A page may name its own finish ("Registering the vault…"). */
export const TX_PHASE_LABEL: Readonly<Record<TxPhase, string>> = {
  prepare: "Preparing…",
  wallet: "Check your wallet…",
  confirm: "Confirming on NEAR…",
  finish: "Finishing…",
  refresh: "Updating the page…",
};

/** Every phase label, for busyLabel's sizes, so a phase change moves nothing. */
export const TX_PHASE_LABELS: readonly string[] = Object.values(TX_PHASE_LABEL);

/**
 * The line in the button's status region in each phase. None while finishing (the page's own note says what happens)
 * or while the page refreshes (the result was already announced).
 */
export const TX_PHASE_LINE: Readonly<Record<TxPhase, string | null>> = {
  prepare: "Building the transaction on the server.",
  wallet: "Approve or reject it in your wallet's window or tab.",
  confirm: "Your wallet sent it. Reading the result from NEAR.",
  finish: null,
  refresh: null,
};

// --- Sign in -------------------------------------------------------------------------------------------------------

/** Sign in's steps: the wallet signs the message, the console checks the signature, then the console opens. */
export type SignInPhase = "wallet" | "verify" | "open";

/** The label while the wallets load. e2e/smoke.spec.ts finds the button by it. */
export const SIGN_IN_NOT_READY_LABEL = "Loading wallets…";

export const SIGN_IN_PHASE_LABEL: Readonly<Record<SignInPhase, string>> = {
  wallet: "Check your wallet…",
  verify: "Checking your signature…",
  open: "Opening your console…",
};

/** Every label the sign-in button can show besides its own, for busyLabel's sizes. */
export const SIGN_IN_LABELS: readonly string[] = [
  SIGN_IN_NOT_READY_LABEL,
  ...Object.values(SIGN_IN_PHASE_LABEL),
];

/** The line while the wallet is asked. Its hint at 20 s is the wallet's (SLOW_HINT.wallet). */
export const SIGN_IN_WALLET_LINE =
  "Approve the sign-in message in your wallet. It is not a transaction and costs nothing.";

/** The challenge and verify requests each stop waiting after this (AbortSignal.timeout). */
export const SIGN_IN_TIMEOUT_MS = 15_000;

export const SIGN_IN_TIMED_OUT = `The server did not answer in ${SIGN_IN_TIMEOUT_MS / 1000} s. You are not signed in. Try again.`;

/** In place of the wallet's raw "User rejected" when the selector or the wallet was closed. */
export const SIGN_IN_CLOSED = "You closed the wallet before signing. You are not signed in.";

// --- Outcomes ------------------------------------------------------------------------------------------------------

/** A retry, for a read or a write that is harmless to repeat. Never offered on a write whose outcome is unknown. */
export const TRY_AGAIN_LABEL = "Try again";
export const TRY_AGAIN_BUSY = "Trying again…";

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/**
 * A read-only server action that did not answer within its timeout (register, key sync, Re-sync). The wait covers the
 * console's one-at-a-time queue as well as the chain, and the action runs on, writing the console's copy of what it
 * read, so the line names the console and does not say that nothing changed.
 */
export function consoleTimedOut(ms: number = ACTION_READ_TIMEOUT_MS): string {
  return `The console did not answer in ${seconds(ms)}. It may still finish: reload the page to see, or try again.`;
}

/** One of our read-only API routes that did not answer within its timeout. */
export function serverTimedOut(ms: number): string {
  return `The server did not answer in ${seconds(ms)}. Nothing was changed. Try again.`;
}

/** A save whose call failed on the way: it may have run, so the page says where to look, not "Try again". */
export const SAVE_UNCLEAR = "The console could not tell whether it saved. Reload the page to see.";
