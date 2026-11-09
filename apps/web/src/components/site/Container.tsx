import type { ReactNode } from "react";

/**
 * The width of every page but the landing page, whose bands run edge to edge. It is the header's frame (`.wrap` in
 * site.module.css): 1320px, with 16px gutters up to 620px and 24px above, so a page's left edge lines up with the logo.
 */
export function Container({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1320px] px-4 py-8 min-[621px]:px-6">{children}</div>;
}
