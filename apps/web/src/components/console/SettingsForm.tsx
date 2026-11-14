"use client";

import { useRef } from "react";
import type { SettingsState } from "@/app/console/[vault]/actions";
import { busyLabel } from "@/components/pending/busy-label";
import { blockableButtonClass, Notice } from "@/components/ui";
import type { TenantKind } from "@/lib/db/tenants";
import { consoleTimedOut, SAVE_UNCLEAR } from "@/lib/ui/pending";
import { readAction, saveAction } from "@/lib/ui/server-action";
import { blockableTextButtonClass, staleNoticeClass } from "./form-look";
import { answerText, type FormRun, tryAgainButton, useFormRun } from "./form-run";

type Action = (prev: SettingsState, formData: FormData) => Promise<SettingsState>;
/** What a form shows: the server's answer, or the console's own when the call gave none, with a Try again. */
type Shown = SettingsState | { ok: false; error: string; retry: true };

const retryable = (s: Shown) => s !== null && !s.ok && "retry" in s;

/**
 * A form's status region: mounted empty, then its last answer, which stays (dimmed) while the form runs again, and the
 * slow hint under it. `held` is any run of the settings, which blocks both forms. Each form keeps its own region, under
 * its own button, so its Try again submits that form (the mockup draws one region under both).
 */
function Result({ run, held }: { run: FormRun<Shown>; held: boolean }) {
  const s = run.state;
  return (
    <div role="status" aria-atomic="false">
      {s === null ? null : (
        <div className={`mt-2 ${run.pending ? staleNoticeClass : ""}`}>
          {s.ok ? (
            <Notice tone="good">{answerText(run.answer, s.message)}</Notice>
          ) : (
            <Notice tone="bad">
              {answerText(run.answer, s.error)}
              {"retry" in s
                ? tryAgainButton({
                    ref: run.refs.retry,
                    type: "submit",
                    busy: run.busy.retry,
                    held,
                    onClick: run.press("retry"),
                  })
                : null}
            </Notice>
          )}
        </div>
      )}
      {run.hint}
    </div>
  );
}

/**
 * The owner's settings. Both actions re-check the owner role on the server, and one runs at a time. Saving the same
 * settings twice is harmless, so a save that may have gone through offers Try again. Re-sync re-reads the chain and
 * records what it read, which is harmless to repeat too: the console stops waiting for it after 20 s, and says it may
 * still finish.
 */
export function SettingsForm({
  vault,
  kind,
  zeroRetention,
  proofPublic,
  save,
  refresh,
}: {
  vault: string;
  /** The tenant's kind: the Canary's ledger is private, so it is not offered a public proof page. */
  kind: TenantKind;
  zeroRetention: boolean;
  proofPublic: boolean;
  save: Action;
  refresh: Action;
}) {
  const lock = useRef(false);
  const saving = useFormRun<Shown>(
    (prev, formData) =>
      saveAction<Shown>(() => save(prev, formData), {
        ok: false,
        error: SAVE_UNCLEAR,
        retry: true,
      }),
    null,
    { kind: "action-write", retryable, lock },
  );
  const syncing = useFormRun<Shown>(
    (prev, formData) =>
      readAction<Shown>(
        () => refresh(prev, formData),
        (why) => ({
          ok: false,
          error:
            why === "timeout" ? consoleTimedOut() : "The console could not re-read the approvers.",
          retry: true,
        }),
      ),
    null,
    { kind: "action-read", retryable, lock },
  );
  const held = saving.pending || syncing.pending;
  return (
    <div className="text-sm">
      <form action={saving.action} onSubmit={saving.onSubmit}>
        <label className="mb-2 block">
          <input type="checkbox" name="zero_retention" defaultChecked={zeroRetention} />{" "}
          Zero-retention: keep only each invoice&apos;s hash, discard its content after the decision
        </label>
        {kind === "canary" ? (
          <p className="mb-2 text-xs text-mute">
            The Canary&apos;s ledger is private: visitors&apos; words never become public.
          </p>
        ) : (
          <label className="mb-2 block">
            <input type="checkbox" name="proof_public" defaultChecked={proofPublic} /> Public proof
            page (ledger, anchors and checks visible to anyone at /proof/{vault})
          </label>
        )}
        <button
          ref={saving.refs.button}
          className={blockableButtonClass}
          type="submit"
          aria-disabled={held || undefined}
          onClick={saving.press("button")}
        >
          {busyLabel("Save settings", "Saving…", saving.busy.button)}
        </button>
        <Result run={saving} held={held} />
      </form>
      <form
        action={syncing.action}
        onSubmit={syncing.onSubmit}
        className="mt-4 border-t border-line pt-3"
      >
        <p className="mb-2 text-xs text-mute">
          The approvers are read from the vault&apos;s on-chain config when it is registered.
        </p>
        <button
          ref={syncing.refs.button}
          className={`text-sm ${blockableTextButtonClass}`}
          type="submit"
          aria-disabled={held || undefined}
          onClick={syncing.press("button")}
        >
          {busyLabel("Re-sync approvers from the chain", "Reading the chain…", syncing.busy.button)}
        </button>
        <Result run={syncing} held={held} />
      </form>
    </div>
  );
}
