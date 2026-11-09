import type { ReactNode } from "react";
import d from "./docs.module.css";

/** One fenced block with a file title above it. */
export function CodeBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <figure className={d.codeTitled}>
      <figcaption className={d.codeTitle}>{title}</figcaption>
      {children}
    </figure>
  );
}
