"use client";

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { buttonClass, dangerButtonClass } from "@/components/ui";
import {
  type Asker,
  type ConfirmOptions,
  type ConfirmSource,
  createAsker,
  isBackdropClick,
} from "@/lib/console/confirm-dialog";

// The console's own confirm box, in place of the browser's `window.confirm`: it names the action it guards, says
// what comes next, and a script can drive it. It is a native `<dialog>` opened with showModal(), so the page behind
// it is inert and the browser keeps focus inside. The rules (only the action says yes; Esc, the backdrop and Cancel
// say no; one question at a time) are in lib/console/confirm-dialog.ts.

const cancelClass =
  "rounded border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-ink hover:bg-stone-100";

/** The dialog itself. Renders nothing while `options` is null; with options, opens as a modal as soon as it mounts. */
export function ConfirmDialog({
  options,
  onSettle,
}: {
  options: ConfirmOptions | null;
  onSettle: (source: ConfirmSource) => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const pressed = useRef<EventTarget | null>(null);
  const isOpen = options !== null;

  useEffect(() => {
    if (!isOpen) return;
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    // The safe choice has the focus: Enter or Space on a dialog that was only just opened does nothing harmful.
    cancel.current?.focus();
  }, [isOpen]);

  if (!options) return null;
  const danger = options.tone === "danger";
  return (
    // Keyboard users have Esc and the Cancel button; the click handlers add the mouse's way out, the backdrop.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc (the cancel event) is the keyboard's way to close it
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border border-ink/10 bg-white p-0 text-ink backdrop:bg-ink/45"
      onCancel={(e) => {
        e.preventDefault(); // the owner's answer closes it (by unmounting), not the browser
        onSettle("escape");
      }}
      onClose={() => onSettle("escape")}
      onMouseDown={(e) => {
        pressed.current = e.target;
      }}
      onClick={(e) => {
        const backdrop = isBackdropClick({
          pressed: pressed.current,
          clicked: e.target,
          dialog: e.currentTarget,
        });
        pressed.current = null;
        if (backdrop) onSettle("backdrop");
      }}
    >
      <div className="p-5 sm:p-7">
        {danger ? (
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-rose-700">
            Cannot be undone
          </p>
        ) : null}
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {options.title}
        </h2>
        <p id={`${id}-body`} className="mt-2 whitespace-pre-line text-sm text-ink/80">
          {options.body}
        </p>
        {options.footnote ? <p className="mt-3 text-xs text-ink/60">{options.footnote}</p> : null}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            ref={cancel}
            type="button"
            className={cancelClass}
            // biome-ignore lint/a11y/noAutofocus: a modal's initial focus, on its safe choice. React does not set the attribute on a dialog opened later, so the effect above focuses it too.
            autoFocus
            onClick={() => onSettle("cancel-button")}
          >
            Cancel
          </button>
          <button
            type="button"
            className={danger ? dangerButtonClass : buttonClass}
            onClick={() => onSettle("action")}
          >
            {options.actionLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * Asks in the console's dialog: `await ask({ title, body, actionLabel, tone?, footnote? })` answers `true` only when
 * the owner uses the action button. Render `dialog` once, anywhere in the component (it shows only while a question is
 * open). While a question is open another `ask` answers `false` and opens nothing. Focus goes back to the element that
 * had it when the question was asked.
 */
export function useConfirm(): {
  ask: (options: ConfirmOptions) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [asker] = useState<Asker>(() => createAsker(setOptions));
  const opener = useRef<HTMLElement | null>(null);

  // A page that goes away with a question open answers it "no", so nothing waits for ever.
  useEffect(() => () => asker.settle("unmount"), [asker]);

  // Once the dialog is gone (after it unmounted, since a modal's page is inert), the opener gets the focus back.
  useEffect(() => {
    if (options !== null) return;
    opener.current?.focus();
    opener.current = null;
  }, [options]);

  const ask = useCallback(
    (next: ConfirmOptions) => {
      if (!asker.open) {
        const active = document.activeElement;
        opener.current = active instanceof HTMLElement ? active : null;
      }
      return asker.ask(next);
    },
    [asker],
  );

  return { ask, dialog: <ConfirmDialog options={options} onSettle={asker.settle} /> };
}
