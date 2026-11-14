import { cloneElement, Fragment, type ReactElement, type ReactNode, useId } from "react";
import { explorerAccountUrl, explorerTxUrl, type Network } from "@/lib/config";
import type { DangerTone } from "@/lib/console/confirm-dialog";

// The console's kit is the landing page's brand: ink pills at least 44px tall, 16px fields (a phone does not zoom in
// on them), hairline cards with a large radius, and the colour tokens of app/globals.css. test/console-kit.test.ts
// holds every text colour it pairs, and every text colour on a console page, to WCAG AAA (7:1).

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";
/** Each tone as a pair of colour tokens: a pale background and the text that reads on it. */
export const TONE_CLASSES: Readonly<Record<Tone, string>> = {
  neutral: "bg-plan-bg text-plan",
  good: "bg-ok-bg text-ok",
  warn: "bg-wait-bg text-wait",
  bad: "bg-bad-bg text-bad",
  info: "border border-line bg-paper text-ink",
};

// The focus ring is the site's (app/globals.css): 2px gold-small, 3px out. Written here too, as a select or a textarea
// is not in that base rule.
const ring =
  "focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-gold-small";
/** A field: 16px text, 44px tall, and the landing page's mute edge, which reads at 3:1 on a white card. */
export const inputClass = `w-full min-h-11 rounded-xl border border-mute bg-surface px-3 py-2 text-base text-ink ${ring}`;
// The colours transition as transition-colors does, and so does opacity, for a button blocked by a running action.
const pillButton = `inline-flex min-h-11 items-center justify-center rounded-full px-5 text-sm font-medium transition-[color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,opacity] ${ring}`;
// A disabled control is exempt from WCAG 1.4.3, and its label still reads at 4.5:1 or more. Ink dims to 65% (about
// 6:1: the ink pill's label is 5.97:1 over a white card). Red dims to 75% (4.89:1): at 65% it would be 3.8:1.
// While an action runs (components/pending), its buttons are aria-disabled, not disabled, so they keep the focus. The
// pressed one holds a busy label ([data-busy]) and shows the progress cursor, at full opacity.
const button = `${pillButton} disabled:opacity-65 has-[[data-busy]]:cursor-progress`;
const redButton = `${pillButton} disabled:opacity-75 has-[[data-busy]]:cursor-progress`;
/** The main button: an ink pill. Its transparent edge shows in forced colours, which drop the fill. */
export const buttonClass = `${button} border border-transparent bg-ink text-paper hover:bg-ink/85`;
/** A second choice beside the main one, such as a dialog's Cancel: an ink outline. */
export const lineButtonClass = `${button} border border-ink/15 bg-surface text-ink hover:bg-ink/5`;
// A button that another action of its widget blocks (Save while Re-sync runs, a form's button while its Try again runs)
// dims as a disabled one does, after the 200 ms gate, and the pressed one keeps full opacity. Opt-in, not on every ink
// pill: a button marked aria-disabled while it works itself, with no busy label yet (the payee check), would dim its own
// busy words. The full opacity is a stacked variant: a plain has-[[data-busy]]:opacity-100 would lose to
// aria-disabled:opacity-65, which Tailwind writes later at the same weight.
const blockedLook =
  "aria-disabled:opacity-65 aria-disabled:delay-200 aria-disabled:has-[[data-busy]]:opacity-100";
/** buttonClass for a button that another action of its widget can block. */
export const blockableButtonClass = `${buttonClass} ${blockedLook}`;
/** lineButtonClass for a button that another action of its widget can block (Try again). */
export const blockableLineButtonClass = `${lineButtonClass} ${blockedLook}`;
/** The action button of a confirm dialog for something that cannot be taken back. */
export const dangerButtonClass = `${redButton} border border-transparent bg-bad text-white hover:bg-bad/90`;
/** A button for something that cannot be taken back, beside other actions (Reject next to Approve): a red outline. */
export const dangerLineButtonClass = `${redButton} border border-bad/45 bg-surface text-bad hover:bg-bad-bg`;

/**
 * A wallet button's look follows its confirm dialog: the red outline when the dialog says it cannot be undone. `wide`
 * fills the row, for the one decision on a phone-sized page.
 */
export function actionButtonClass(confirmTone?: DangerTone, wide?: boolean): string {
  const look = confirmTone === "danger" ? dangerLineButtonClass : buttonClass;
  return wide ? `${look} w-full` : look;
}

// Brand v2 (light): ink pills, hairline cards with a large radius, and status panels whose colour carries meaning
// (green passed, amber not proven or no result, red failed). The colours are the tokens in app/globals.css.
const pill =
  "inline-flex items-center rounded-full px-4 py-2 text-sm font-medium transition-colors";
export const inkPillClass = `${pill} border border-transparent bg-ink text-paper hover:bg-ink/85`;
export const linePillClass = `${pill} border border-ink/15 text-ink hover:bg-ink/5`;
export const brandCardClass = "mb-6 rounded-3xl border border-ink/10 bg-white p-5 sm:p-7";
export type PanelTone = "good" | "warn" | "bad";
export const PANEL_TONES: Readonly<Record<PanelTone, { box: string; dot: string }>> = {
  good: { box: "border-emerald-200 bg-emerald-50 text-emerald-950", dot: "bg-emerald-600" },
  warn: { box: "border-amber-200 bg-amber-50 text-amber-950", dot: "bg-amber-500" },
  bad: { box: "border-rose-200 bg-rose-50 text-rose-950", dot: "bg-rose-600" },
};

/** A link that opens in a new tab, and says so to a screen reader. */
export function ExternalLink({
  href,
  className,
  title,
  children,
}: {
  href: string;
  className?: string;
  /** A Markdown link's title, kept as the tooltip. */
  title?: string;
  children: ReactNode;
}) {
  return (
    <a className={className} href={href} title={title} target="_blank" rel="noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * A paragraph in a card runs to the reading measure (80 characters or fewer, WCAG 1.4.8); tables and forms keep the card
 * width. The title is light only because it is 24px, large text.
 */
export function Card({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-6 rounded-3xl border border-line bg-surface p-5 sm:p-7 [&_p]:max-w-measure">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-2xl font-light tracking-tight">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Notice({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div className={`mb-4 rounded-2xl px-4 py-3 text-sm ${TONE_CLASSES[tone]}`}>
      <div className="max-w-measure">{children}</div>
    </div>
  );
}

type ControlProps = { id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean };

/**
 * A labelled form control. The label points at the control with `htmlFor`, and the control is its
 * sibling (not nested in the label). `children` is exactly one element: it receives the generated
 * `id` (a caller-supplied `id` is kept), `aria-describedby` for the hint or error (added to any
 * the element already has), and `aria-invalid` when there is an error. Only keys with a value are
 * set, so nothing the element already carries is overwritten with `undefined`.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactElement<ControlProps>;
}) {
  const uid = useId();
  const noteId = error ? `${uid}-error` : hint ? `${uid}-hint` : undefined;
  const controlId = children.props.id ?? uid;
  const extra: ControlProps = { id: controlId };
  const describedBy = [children.props["aria-describedby"], noteId].filter(Boolean).join(" ");
  if (describedBy) extra["aria-describedby"] = describedBy;
  if (error) extra["aria-invalid"] = true;
  return (
    <div className="mb-3 block text-sm">
      <label htmlFor={controlId} className="mb-1 block font-medium">
        {label}
      </label>
      {children.type === Fragment ? children : cloneElement(children, extra)}
      {hint && !error ? (
        <span id={noteId} className="mt-1 block text-xs text-mute">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={noteId} className="mt-1 block text-xs text-bad">
          {error}
        </span>
      ) : null}
    </div>
  );
}

const explorerLinkClass =
  "mono text-ink underline decoration-ink/60 underline-offset-2 hover:decoration-ink";
const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);

export function TxLink({
  network,
  hash,
  label,
}: {
  network: Network;
  hash: string;
  label?: string;
}) {
  return (
    <a
      className={explorerLinkClass}
      href={explorerTxUrl(network, hash)}
      target="_blank"
      rel="noreferrer"
    >
      {label ?? short(hash)}
    </a>
  );
}

export function AccountLink({ network, account }: { network: Network; account: string }) {
  return (
    <a
      className={explorerLinkClass}
      href={explorerAccountUrl(network, account)}
      target="_blank"
      rel="noreferrer"
    >
      {account}
    </a>
  );
}
