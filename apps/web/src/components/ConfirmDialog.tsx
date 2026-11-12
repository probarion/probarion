"use client";

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buttonClass, dangerButtonClass, lineButtonClass } from "@/components/ui";
import {
  type Asker,
  actionClickAllowed,
  type ConfirmOptions,
  type ConfirmSource,
  createAsker,
  isBackdropClick,
  pickOpener,
} from "@/lib/console/confirm-dialog";

// The console's own confirm box, in place of the browser's `window.confirm`: it names the action it guards, says
// what comes next, and a script can drive it. It is a native `<dialog>` opened with showModal(), so the page behind
// it is inert and the browser keeps focus inside. The rules (only the action says yes; Esc, the backdrop and Cancel
// say no; one question at a time) are in lib/console/confirm-dialog.ts.

const focusable = (e: Element | null): e is HTMLElement =>
  !!e && typeof (e as HTMLElement).focus === "function";

/**
 * The dialog itself. Renders nothing while `options` is null; with options, opens as a modal as soon as it mounts. It
 * is rendered into `document.body` (a portal), so a `<fieldset disabled>` or a clickable ancestor of the button that
 * asked cannot reach it; its clicks do not bubble on to the page either. With no `document` (the server render) it is
 * rendered where it is.
 */
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
  const openedAt = useRef(0);
  const isOpen = options !== null;

  useEffect(() => {
    if (!isOpen) return;
    openedAt.current = Date.now();
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    // The safe choice has the focus: Enter or Space on a dialog that was only just opened does nothing harmful.
    cancel.current?.focus();
  }, [isOpen]);

  if (!options) return null;
  const danger = options.tone === "danger";
  const panel = (
    // Keyboard users have Esc and the Cancel button; the click handlers add the mouse's way out, the backdrop.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc (the cancel event) is the keyboard's way to close it
    <dialog
      ref={dialog}
      // A red dialog is an alert: the screen reader reads "Cannot be undone" first, then the question.
      role={danger ? "alertdialog" : undefined}
      aria-labelledby={`${id}-title`}
      aria-describedby={danger ? `${id}-warning ${id}-body` : `${id}-body`}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border border-line bg-surface p-0 text-ink backdrop:bg-ink/45"
      onCancel={(e) => {
        e.preventDefault(); // the owner's answer closes it (by unmounting), not the browser
        onSettle("escape");
      }}
      onClose={() => onSettle("close")}
      onMouseDown={(e) => {
        e.stopPropagation();
        pressed.current = e.target;
      }}
      onClick={(e) => {
        e.stopPropagation();
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
          <p
            id={`${id}-warning`}
            className="mb-1 text-xs font-medium uppercase tracking-wide text-bad"
          >
            Cannot be undone
          </p>
        ) : null}
        {/* An account id has no spaces to break at: a 64-character implicit one, or a long name, wraps anywhere
            in the title, the body and the footnote instead of pushing the dialog sideways. */}
        <h2 id={`${id}-title`} className="text-2xl font-light tracking-tight wrap-anywhere">
          {options.title}
        </h2>
        <p id={`${id}-body`} className="mt-2 whitespace-pre-line text-sm text-ink/80 wrap-anywhere">
          {options.body}
        </p>
        {options.footnote ? (
          <p className="mt-3 text-xs text-mute wrap-anywhere">{options.footnote}</p>
        ) : null}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            ref={cancel}
            type="button"
            className={lineButtonClass}
            // biome-ignore lint/a11y/noAutofocus: a modal's initial focus, on its safe choice. React does not set the attribute on a dialog opened later, so the effect above focuses it too.
            autoFocus
            onClick={() => onSettle("cancel-button")}
          >
            Cancel
          </button>
          <button
            type="button"
            className={danger ? dangerButtonClass : buttonClass}
            onClick={(e) => {
              // Not the second click of a double click on the button that opened the dialog.
              if (
                actionClickAllowed({
                  openedAt: openedAt.current,
                  now: Date.now(),
                  detail: e.detail,
                })
              ) {
                onSettle("action");
              }
            }}
          >
            {options.actionLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
  return typeof document === "undefined" ? panel : createPortal(panel, document.body);
}

/**
 * Asks in the console's dialog: `await ask({ title, body, actionLabel, tone?, footnote? })` answers `true` only when
 * the owner uses the action button. Render `dialog` once, anywhere in the component (it shows only while a question is
 * open). While a question is open another `ask` answers `false` and opens nothing. Focus goes back to the element
 * passed as `opener` (the button that was clicked: `ask(options, event.currentTarget)`), or to the one that had it when
 * the question was asked.
 *
 * The one-question guard belongs to one `useConfirm()`, not to the page. Two buttons with a hook each are kept from
 * stacking two dialogs by the first one being modal: the rest of the page is inert while it is open.
 */
export function useConfirm(): {
  ask: (options: ConfirmOptions, opener?: HTMLElement | null) => Promise<boolean>;
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
    (next: ConfirmOptions, from?: HTMLElement | null) => {
      if (!asker.open) {
        const active = document.activeElement;
        opener.current = pickOpener(from, focusable(active) ? active : null);
      }
      return asker.ask(next);
    },
    [asker],
  );

  return { ask, dialog: <ConfirmDialog options={options} onSettle={asker.settle} /> };
}
