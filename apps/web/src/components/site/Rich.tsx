import { createElement, Fragment, type ReactNode } from "react";
import { richParts } from "@/lib/site/rich";

/** One line of copy from `lib/site/facts.ts`: the parts in backticks render as code. */
export function Rich({ text }: { text: string }) {
  const parts: ReactNode[] = richParts(text).map((part) =>
    part.code ? createElement("code", null, part.text) : part.text,
  );
  return createElement(Fragment, null, ...parts);
}
