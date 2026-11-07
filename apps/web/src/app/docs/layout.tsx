import type { ReactNode } from "react";
import d from "@/components/docs/docs.module.css";

/**
 * Inside the site's <main id="main">: the docs add no second main. Task 9 mounts the search dialog
 * here.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return <div className={d.docs}>{children}</div>;
}
