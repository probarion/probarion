import type { ReactNode } from "react";
import d from "./docs.module.css";

/** Numbered steps: wraps one Markdown ordered list. */
export function Steps({ children }: { children: ReactNode }) {
  return <div className={d.steps}>{children}</div>;
}
