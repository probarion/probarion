import type { ReactNode } from "react";

// The parts a loading.tsx shell is built from. They are decoration: each is aria-hidden, and the shell around them says
// what is loading (an sr-only line, aria-busy on the shell). The bars are the docs' soft fill, pulsing to 0.45 and back,
// and still under reduced motion; in forced colours, which drop the fill, an edge in the text colour keeps them seen.

const bar =
  "block rounded-md bg-soft motion-safe:animate-skeleton forced-colors:border forced-colors:border-[CanvasText]";

/** One grey bar. Its size comes from `className` (h-[21px] w-48 is one line of text-sm). */
export function SkeletonBar({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`${bar} ${className}`} />;
}

/**
 * A Card's shell (components/ui.tsx Card) with a title bar and `bars` lines of text. `minH` is a min-height class
 * written out in full where it is used ("min-h-[320px]"), so the page does not jump when the real card lands.
 */
export function SkeletonCard({ bars = 3, minH = "min-h-40" }: { bars?: number; minH?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`mb-6 rounded-3xl border border-line bg-surface p-5 sm:p-7 ${minH}`}
    >
      <SkeletonBar className="mb-4 h-8 w-48 max-w-full" />
      {Array.from({ length: bars }, (_, i) => (
        <SkeletonBar
          // biome-ignore lint/suspicious/noArrayIndexKey: identical bars, never reordered.
          key={i}
          className={`mb-3 h-[21px] ${i === bars - 1 ? "w-2/3" : "w-full"}`}
        />
      ))}
    </div>
  );
}

/**
 * The skeleton's body. It fades in after the 200 ms gate, so a navigation that lands sooner never flashes grey blocks;
 * the real header and nav beside it are not wrapped and show at once.
 */
export function SkeletonBody({ children }: { children: ReactNode }) {
  return <div className="animate-pending-in">{children}</div>;
}
