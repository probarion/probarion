import type { ReactNode } from "react";
import { CALLOUT_KINDS, type CalloutKind, calloutFooter, isCalloutKind } from "@/lib/docs/callouts";
import d from "./docs.module.css";

const TONE: Record<CalloutKind, string | undefined> = {
  note: undefined,
  warning: d.warning,
  "owner-signs": d.signs,
  "approver-signs": d.signs,
  key: d.key,
};

/**
 * A boxed note: `role="note"`, not `<aside>`, so a page with many callouts adds no landmarks. An unknown kind throws,
 * so a typo fails the build instead of shipping an unmarked box.
 */
export function Callout({
  kind,
  title,
  children,
}: {
  kind: CalloutKind;
  title?: string;
  children: ReactNode;
}) {
  if (!isCalloutKind(kind)) throw new Error(`Callout: unknown kind "${String(kind)}"`);
  const footer = calloutFooter(kind);
  return (
    <div
      role="note"
      className={`${d.callout} ${TONE[kind] ?? ""}`}
      aria-label={title ?? CALLOUT_KINDS[kind].label}
    >
      <p className={d.calloutTitle}>{title ?? CALLOUT_KINDS[kind].label}</p>
      <div className={d.calloutBody}>{children}</div>
      {footer && <p className={d.calloutFooter}>{footer}</p>}
    </div>
  );
}
