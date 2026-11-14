"use client";

import { useRef, useState } from "react";
import type { TelegramState } from "@/app/console/[vault]/alerts/actions";
import { busyLabel } from "@/components/pending/busy-label";
import { useElapsed } from "@/components/pending/hooks";
import { buttonClass, ExternalLink, Notice } from "@/components/ui";
import { slowHint } from "@/lib/ui/pending";
import { handFocus, saveAction } from "@/lib/ui/server-action";
import { staleNoticeClass } from "./form-look";
import { hintLine, tryAgainButton } from "./form-run";

/** What the button shows: the server's answer, or the console's own when the call gave none, with a Try again. */
type Shown = TelegramState | { ok: false; error: string; retry: true };

// A link made twice is harmless (each works once, for 24 hours), so a call that gave no answer offers Try again.
const FAILED: Shown = {
  ok: false,
  error: "The link could not be made. Try again in a minute.",
  retry: true,
};

/**
 * The Telegram button of the Alerts tab: it makes the link, and shows it. The server action re-checks the role. One
 * call at a time: while it runs the button stays focusable (aria-disabled) and a press does nothing.
 */
export function TelegramConnect({ connect }: { connect: () => Promise<TelegramState> }) {
  const [state, setState] = useState<Shown | null>(null);
  /** The button that started the call that runs, or null. */
  const [busy, setBusy] = useState<"button" | "retry" | null>(null);
  // A ref, not the state: a second press can come before the render that shows the first.
  const running = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const elapsed = useElapsed(busy !== null);
  const make = async (via: "button" | "retry" = "button") => {
    if (running.current) return;
    running.current = true;
    setBusy(via);
    try {
      const next = await saveAction<Shown>(connect, FAILED);
      if (!("retry" in next)) handFocus(retry.current, button.current);
      setState(next);
    } finally {
      running.current = false;
      setBusy(null);
    }
  };
  return (
    <div>
      <button
        ref={button}
        type="button"
        className={buttonClass}
        aria-disabled={busy !== null || undefined}
        onClick={() => make()}
      >
        {busyLabel("Create a Telegram link", "Making the link…", busy === "button")}
      </button>
      <div role="status">
        {state?.ok ? (
          <p className="mt-3 text-sm">
            Open{" "}
            <ExternalLink
              className="mono text-ink underline decoration-ink/60 break-all"
              href={state.link}
            >
              {state.link.replace("https://", "")}
            </ExternalLink>{" "}
            and press Start.
          </p>
        ) : null}
        {state !== null && !state.ok ? (
          <div className={`mt-3 ${busy !== null ? staleNoticeClass : ""}`}>
            <Notice tone="bad">
              {state.error}
              {"retry" in state
                ? tryAgainButton({
                    ref: retry,
                    type: "button",
                    busy: busy === "retry",
                    held: busy !== null,
                    onClick: () => make("retry"),
                  })
                : null}
            </Notice>
          </div>
        ) : null}
        {hintLine(busy !== null ? slowHint("action-write", elapsed) : null, elapsed)}
      </div>
    </div>
  );
}
