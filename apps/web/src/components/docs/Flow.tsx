import type { ReactNode } from "react";
import d from "./docs.module.css";

/** A step strip: wraps one Markdown ordered list whose items start with a bold title. One column on a phone. */
export function Flow({ children }: { children: ReactNode }) {
  return <div className={d.flow}>{children}</div>;
}
