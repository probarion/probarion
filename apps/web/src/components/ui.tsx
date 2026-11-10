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
const button = `inline-flex min-h-11 items-center justify-center rounded-full px-5 text-sm font-medium transition-colors disabled:opacity-50 ${ring}`;
/** The main button: an ink pill. */
export const buttonClass = `${button} bg-ink text-paper hover:bg-ink/85`;
/** A second choice beside the main one, such as a dialog's Cancel: an ink outline. */
export const lineButtonClass = `${button} border border-ink/15 bg-surface text-ink hover:bg-ink/5`;
/** The action button of a confirm dialog for something that cannot be taken back. */
export const dangerButtonClass = `${button} bg-bad text-white hover:bg-bad/90`;
/** A button for something that cannot be taken back, beside other actions (Reject next to Approve): a red outline. */
export const dangerLineButtonClass = `${button} border border-bad/45 bg-surface text-bad hover:bg-bad-bg`;

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
export const inkPillClass = `${pill} bg-ink text-paper hover:bg-ink/85`;
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
    <section className="mb-6 rounded-3xl border border-line bg-surface p-5 sm:p-7">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-[22px] font-light tracking-tight">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Notice({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div className={`mb-4 rounded-2xl px-4 py-3 text-sm ${TONE_CLASSES[tone]}`}>{children}</div>
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
  "mono text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink";
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
