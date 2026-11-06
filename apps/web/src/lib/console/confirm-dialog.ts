// The logic behind the console's confirm dialog (components/ConfirmDialog.tsx), kept apart from the markup so it can be
// tested without a browser: who can say yes, what counts as no, and what a second question does while one is open.

/** "danger" is for what cannot be taken back: a red action button and a "Cannot be undone" line above the title. */
export type ConfirmTone = "normal" | "danger";
/** What a prop names when it asks for the red dialog: "normal" is what no prop at all means. */
export type DangerTone = Exclude<ConfirmTone, "normal">;

export interface ConfirmOptions {
  /** The action's own label, never "OK". */
  title: string;
  /** The question, shown as it is written. A blank line in it stays a paragraph break. */
  body: string;
  /** The text of the button that goes ahead: the same as the title. */
  actionLabel: string;
  tone?: ConfirmTone;
  footnote?: string;
}

/**
 * What the owner did to close the dialog. Only the action button says yes. Anything else says no: the Cancel button,
 * Esc, a click on the dimmed backdrop, the browser closing the dialog on its own ("close"), or the page going
 * away with the question still open.
 */
export type ConfirmSource =
  | "action"
  | "cancel-button"
  | "escape"
  | "backdrop"
  | "close"
  | "unmount";

export interface Asker {
  /** Opens the dialog and resolves with the owner's answer. While one is open, a new ask resolves `false` at once. */
  ask(options: ConfirmOptions): Promise<boolean>;
  /** The owner closed the dialog. Does nothing when none is open (a late click cannot turn a no into a yes). */
  settle(source: ConfirmSource): void;
  /** The question on screen, or null. */
  readonly open: ConfirmOptions | null;
}

/** `onChange` is told when a question opens (with its options) and when it closes (with null). */
export function createAsker(onChange: (open: ConfirmOptions | null) => void): Asker {
  let current: { options: ConfirmOptions; resolve: (yes: boolean) => void } | null = null;
  return {
    ask(options) {
      // One dialog at a time: a second click on the same button, or a second button, must not stack a dialog or
      // answer for the first one.
      if (current) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        current = { options, resolve };
        onChange(options);
      });
    },
    settle(source) {
      if (!current) return;
      const { resolve } = current;
      current = null;
      onChange(null);
      resolve(source === "action");
    },
    get open() {
      return current?.options ?? null;
    },
  };
}

/**
 * Whether a click closed the dialog by landing on the backdrop. The dialog element is the backdrop's target and
 * its panel fills the element, so a click on the dimmed area reports the dialog itself. The press must have begun
 * there too: selecting text in the panel and letting go over the backdrop is not a click on it.
 */
export function isBackdropClick(e: {
  pressed: unknown;
  clicked: unknown;
  dialog: unknown;
}): boolean {
  return e.pressed === e.dialog && e.clicked === e.dialog;
}

/** How long the action button ignores clicks after the dialog opens (the second click of a double click on the opener). */
export const ACTION_GUARD_MS = 400;

/**
 * Whether a click on the action button counts. A double click on the button that opened the dialog must not land its
 * second click on the action: the dialog is up before that click arrives, so the action is held back for a moment, and
 * a click that is itself the second of a double click (`detail` above 1) never counts. A click from the keyboard has
 * `detail` 0.
 */
export function actionClickAllowed(e: { openedAt: number; now: number; detail: number }): boolean {
  return e.detail <= 1 && e.now - e.openedAt >= ACTION_GUARD_MS;
}

/** Where the focus goes back to: the element the caller says opened the question, else the one that had focus. */
export function pickOpener<T>(given: T | null | undefined, active: T | null): T | null {
  return given ?? active;
}

export const SIGN_FOOTNOTE = "Next, your wallet asks you to sign. Nothing is sent until you do.";

/** What a wallet button asks before it asks the wallet: its own label, its confirm text, and its tone. */
export function walletConfirm(b: {
  label: string;
  confirm: string;
  confirmTone?: DangerTone;
}): ConfirmOptions {
  return {
    title: b.label,
    actionLabel: b.label,
    body: b.confirm,
    tone: b.confirmTone ?? "normal",
    footnote: SIGN_FOOTNOTE,
  };
}
