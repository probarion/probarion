import type { ReactElement } from "react";
import { ELAPSED_FROM_MS, formatElapsed, type SlowHint } from "@/lib/ui/pending";

// The pieces of a widget's status region (one polite role="status" element per widget, mounted on first render; these
// add no live region of their own). A clock is aria-hidden, so a region that ticks each second is not read out each
// second. Called as functions, like busyLabel, so their text stays host children.

/** " 0:42" after a status line, from 5 s on; nothing before. */
export function elapsedClock(ms: number): ReactElement | null {
  return ms >= ELAPSED_FROM_MS ? (
    <span aria-hidden="true" className="tabular-nums">{` ${formatElapsed(ms)}`}</span>
  ) : null;
}

/**
 * A slow hint's words for its own line in the region: "Still saving (0:06). The console finishes one request at a
 * time.", read out as "Still saving. The console finishes one request at a time." Add it to the region as a new keyed
 * line under the ones already there: redrawing the region would have a screen reader repeat all of it.
 */
export function hintText(hint: SlowHint, elapsedMs: number): ReactElement {
  if (hint.rest === undefined) return <>{hint.lead}</>;
  return (
    <>
      {hint.lead}
      <span aria-hidden="true" className="tabular-nums">
        {` (${formatElapsed(elapsedMs)})`}
      </span>
      {`. ${hint.rest}`}
    </>
  );
}
