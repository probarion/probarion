import { createElement, Fragment, type ReactNode } from "react";

/** One line of copy from `lib/site/facts.ts`: the parts in backticks render as code. */
export function Rich({ text }: { text: string }) {
  const parts: ReactNode[] = text
    .split(/(`[^`]+`)/)
    .map((part) => (part.startsWith("`") ? createElement("code", null, part.slice(1, -1)) : part));
  return createElement(Fragment, null, ...parts);
}
