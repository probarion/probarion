"use client";

import type { AlertsState } from "@/app/console/[vault]/alerts/actions";
import { busyLabel } from "@/components/pending/busy-label";
import { buttonClass, inputClass, Notice } from "@/components/ui";
import { SAVE_UNCLEAR } from "@/lib/ui/pending";
import { saveAction } from "@/lib/ui/server-action";
import { staleNoticeClass } from "./form-look";
import { answerText, useFormRun } from "./form-run";

type Action = (prev: AlertsState, formData: FormData) => Promise<AlertsState>;

/**
 * The email box of the Alerts tab. The action re-checks the role on the server and answers a sentence. It sends an
 * email, so a call that fails on the way offers no Try again: it may have sent one.
 */
export function AddEmailForm({ add }: { add: Action }) {
  const run = useFormRun<AlertsState>(
    (prev, formData) =>
      saveAction<AlertsState>(() => add(prev, formData), { ok: false, error: SAVE_UNCLEAR }),
    null,
    { kind: "action-write" },
  );
  const state = run.state;
  return (
    <form action={run.action} onSubmit={run.onSubmit}>
      <div className="flex flex-wrap gap-2">
        <input
          className={`${inputClass} max-w-sm`}
          type="email"
          name="email"
          placeholder="finance@example.com"
          aria-label="Email address"
          autoComplete="email"
          maxLength={254}
          required
        />
        <button
          ref={run.refs.button}
          className={buttonClass}
          type="submit"
          aria-disabled={run.pending || undefined}
          onClick={run.press("button")}
        >
          {busyLabel("Send confirmation", "Sending…", run.busy.button)}
        </button>
      </div>
      <div role="status" aria-atomic="false">
        {state === null ? null : (
          <div className={`mt-3 ${run.pending ? staleNoticeClass : ""}`}>
            <Notice tone={state.ok ? "good" : "bad"}>
              {answerText(run.answer, state.ok ? state.message : state.error)}
            </Notice>
          </div>
        )}
        {run.hint}
      </div>
    </form>
  );
}
