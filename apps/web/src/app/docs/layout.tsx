import type { ReactNode } from "react";
import d from "@/components/docs/docs.module.css";
import { SearchDialog } from "@/components/docs/SearchDialog";
import { docsHref, findPage } from "@/lib/docs/registry";

/**
 * Inside the site's <main id="main">: the docs add no second main. The search dialog serves every
 * docs page.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  const glossary = findPage("resources/glossary");
  return (
    <div className={d.docs}>
      {children}
      <SearchDialog glossaryHref={glossary ? docsHref(glossary.path) : null} />
    </div>
  );
}
