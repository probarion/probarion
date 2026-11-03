import { cloneElement, Fragment, type ReactElement, type ReactNode, useId } from "react";
import { explorerAccountUrl, explorerTxUrl, type Network } from "@/lib/config";

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";
const TONES: Record<Tone, string> = {
  neutral: "bg-stone-100 text-stone-700",
  good: "bg-emerald-100 text-emerald-800",
  warn: "bg-amber-100 text-amber-900",
  bad: "bg-rose-100 text-rose-800",
  info: "bg-sky-100 text-sky-800",
};

export const inputClass = "w-full rounded border border-stone-300 bg-white px-2 py-1 text-sm";
export const buttonClass =
  "rounded bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50";

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>
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
    <section className="mb-6 rounded-lg border border-stone-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Notice({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`mb-4 rounded px-3 py-2 text-sm ${TONES[tone]}`}>{children}</div>;
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
        <span id={noteId} className="mt-1 block text-xs text-stone-500">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={noteId} className="mt-1 block text-xs text-rose-700">
          {error}
        </span>
      ) : null}
    </div>
  );
}

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
      className="mono text-sky-700 underline"
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
      className="mono text-sky-700 underline"
      href={explorerAccountUrl(network, account)}
      target="_blank"
      rel="noreferrer"
    >
      {account}
    </a>
  );
}
