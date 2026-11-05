import type { ReactNode } from "react";

/** The width of every page but the landing page, whose bands run edge to edge. */
export function Container({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-5xl px-4 py-8">{children}</div>;
}
