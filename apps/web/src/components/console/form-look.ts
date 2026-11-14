// The looks a console form adds around its busy labels. Plain strings in a module of their own, with no "use client",
// so the server pages' forms (Discard, Remove, Save zero retention) use them as the client forms do.

/**
 * An underlined text button (Re-sync, Keep, Discard, Remove) whose label is a busyLabel. The label's inline grid takes
 * the button's underline (globals.css `.busy-label`), so the line stays under the old label during the 200 ms gate too.
 * The pressed one shows the progress cursor, as ui.tsx's buttons do.
 */
export const textButtonClass = "underline has-[[data-busy]]:cursor-progress";

/**
 * A text button that another action of its widget can block: it dims as ui.tsx's ink buttons do, to 65%, after the
 * 200 ms gate, and the pressed one keeps full opacity (the stacked variant, as Tailwind writes aria-* after has-*).
 */
export const blockableTextButtonClass = `${textButtonClass} transition-opacity disabled:opacity-65 aria-disabled:opacity-65 aria-disabled:delay-200 aria-disabled:has-[[data-busy]]:opacity-100`;

/**
 * Put on the element that holds a form's last Notice while the form runs again: the old answer stays where it is and
 * turns to the mute tone (plan on plan-bg, 7:1) after the 200 ms gate, with a 150 ms colour fade. The busy label and its
 * spinner carry the signal; the dim only says the answer is the last one. The new answer comes back at once.
 */
export const staleNoticeClass =
  "[&>div]:bg-plan-bg [&>div]:text-plan [&>div]:transition-colors [&>div]:delay-200 [&>div]:duration-150";
