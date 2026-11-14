// How a console form waits on its server action (spec 4.2): a read is waited on for 20 s at most, a save as long as it
// takes, and neither throws into the page, so a call that fails on the way becomes a sentence in the form's own status
// region, not the root error page. Pure, so it is unit-tested without React.

import { within } from "@/lib/within";
import { ACTION_READ_TIMEOUT_MS } from "./pending";

/** Why a read-only action gave no answer: the wait ran out (`timeout`), or the call itself failed (`failed`). */
export type ReadFailure = "timeout" | "failed";

/**
 * A server action that only reads (the chain, then the console's copy of it), waited on for at most `ms`. `within`
 * stops the waiting only: a server action cannot be cancelled, so it runs on and keeps its place in the console's
 * one-at-a-time queue, and a Try again waits behind it. It never rejects: no answer is `fail`'s state.
 */
export async function readAction<S>(
  run: () => Promise<S>,
  fail: (why: ReadFailure) => S,
  ms: number = ACTION_READ_TIMEOUT_MS,
): Promise<S> {
  // Set once the action itself has ended, so a rejection after that is its own failure, not the wait running out.
  let ended = false;
  try {
    return await within(async () => {
      try {
        return await run();
      } finally {
        ended = true;
      }
    }, ms);
  } catch {
    return fail(ended ? "failed" : "timeout");
  }
}

/**
 * A server action that saves. It has no timeout (the page's maxDuration bounds it) and is never repeated by itself; a
 * call that fails on the way answers `failed`, which says it may have saved (SAVE_UNCLEAR), as it may have.
 */
export async function saveAction<S>(run: () => Promise<S>, failed: S): Promise<S> {
  try {
    return await run();
  } catch {
    return failed;
  }
}

/**
 * Moves the focus from `from` to `to` when `from` holds it: a Try again whose notice is about to give way to the
 * answer hands the focus to its form's own button first, so it does not drop to the page.
 */
export function handFocus(from: HTMLElement | null, to: HTMLElement | null): void {
  if (from !== null && to !== null && from.ownerDocument.activeElement === from) to.focus();
}
