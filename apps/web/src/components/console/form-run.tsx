"use client";

import {
  type FormEvent,
  type MouseEvent,
  type ReactElement,
  type RefObject,
  useActionState,
  useRef,
  useState,
} from "react";
import { busyLabel } from "@/components/pending/busy-label";
import { useElapsed } from "@/components/pending/hooks";
import { hintText } from "@/components/pending/status-line";
import { lineButtonClass } from "@/components/ui";
import {
  type SlowHint,
  slowHint,
  TRY_AGAIN_BUSY,
  TRY_AGAIN_LABEL,
  type WaitKind,
} from "@/lib/ui/pending";
import { handFocus } from "@/lib/ui/server-action";

// A console form's run (spec 5.4 and 5.5): one action at a time, the buttons aria-disabled (not disabled, so the one
// pressed keeps the focus) while it runs, the slow hint added to the form's status region as a line of its own, and a
// Try again that hands the focus back to the form's button before its notice gives way.

/** The button that sent the form: its own, or the Try again in its status region. */
type Via = "button" | "retry";

export interface FormRun<S> {
  /** The form's last answer, kept while it runs again. */
  state: S;
  /** The form's `action`. */
  action: (formData: FormData) => void;
  /** The form's action runs. */
  pending: boolean;
  /** Which label turns busy: the form's own button's, or Try again's (the other stays as it is, aria-disabled). */
  busy: Readonly<Record<Via, boolean>>;
  /** The form's own button and its Try again, for the focus hand-over. */
  refs: Readonly<Record<Via, RefObject<HTMLButtonElement | null>>>;
  /** The form's onSubmit: a submit while an action of the widget runs does nothing. */
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  /** A button's onClick: a press while an action of the widget runs does nothing, Enter in a field included. */
  press: (via: Via) => (e: MouseEvent<HTMLButtonElement>) => void;
  /** The slow hint's line, for under what the status region shows already, or null before the slow mark. */
  hint: ReactElement | null;
}

/**
 * A form's server action, run with useActionState behind a guard. `run` must not throw (readAction and saveAction
 * answer a state instead), as a thrown action takes the page to its error boundary. `retryable` says which answers carry
 * a Try again; any other answer takes the focus from Try again to the form's own button first. `lock` is shared by the
 * forms of one widget (the settings' Save and Re-sync), so one runs at a time.
 */
export function useFormRun<S>(
  run: (prev: S, formData: FormData) => Promise<S>,
  initial: S,
  opts: {
    kind: Extract<WaitKind, "action-read" | "action-write">;
    retryable?: (state: S) => boolean;
    lock?: RefObject<boolean>;
  },
): FormRun<S> {
  // A ref, not the pending flag: a second press can come before the render that shows the first.
  const own = useRef(false);
  const lock = opts.lock ?? own;
  const button = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const [via, setVia] = useState<Via>("button");
  const [state, action, pending] = useActionState<S, FormData>(
    async (prev, formData) => {
      try {
        const next = await run(prev, formData);
        if (!(opts.retryable?.(next) ?? false)) handFocus(retry.current, button.current);
        return next;
      } finally {
        lock.current = false;
      }
    },
    initial as Awaited<S>,
  );
  const elapsed = useElapsed(pending);
  return {
    state,
    action,
    pending,
    busy: { button: pending && via === "button", retry: pending && via === "retry" },
    refs: { button, retry },
    onSubmit: (e) => {
      if (lock.current) {
        e.preventDefault();
        return;
      }
      lock.current = true;
    },
    press: (which) => (e) => {
      if (lock.current) {
        e.preventDefault();
        return;
      }
      setVia(which);
    },
    hint: hintLine(pending ? slowHint(opts.kind, elapsed) : null, elapsed),
  };
}

/** The slow hint as its own line of a status region, under the lines already there, or null. */
export function hintLine(hint: SlowHint | null, elapsedMs: number): ReactElement | null {
  return hint === null ? null : (
    <p key="hint" className="mt-2 text-xs text-mute">
      {hintText(hint, elapsedMs)}
    </p>
  );
}

/**
 * Try again, in the notice of an answer that offers it. It stays mounted and focused while it runs, aria-disabled, with
 * "Trying again…" as its label. In a form it submits the form again (`type="submit"`); elsewhere `onClick` runs it.
 */
export function tryAgainButton(props: {
  ref: RefObject<HTMLButtonElement | null>;
  type: "submit" | "button";
  /** Try again's own run. */
  busy: boolean;
  /** Any run of its widget. */
  held: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
}): ReactElement {
  return (
    <div className="mt-2">
      <button
        ref={props.ref}
        type={props.type}
        className={lineButtonClass}
        aria-disabled={props.held || undefined}
        onClick={props.onClick}
      >
        {busyLabel(TRY_AGAIN_LABEL, TRY_AGAIN_BUSY, props.busy)}
      </button>
    </div>
  );
}
