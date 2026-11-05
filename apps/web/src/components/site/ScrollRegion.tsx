import type { ReactNode } from "react";

/**
 * A panel that may scroll sideways on a narrow screen. It takes keyboard focus, or a keyboard user could not scroll it,
 * and the role and label say what it holds.
 */
export function ScrollRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1).
    <section className={className} aria-label={label} tabIndex={0}>
      {children}
    </section>
  );
}
