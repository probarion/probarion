import Link from "next/link";
import { docsHref, navLabel } from "@/lib/docs/registry";
import type { DocPage } from "@/lib/docs/types";
import d from "./docs.module.css";

export function Pager({ prev, next }: { prev?: DocPage; next?: DocPage }) {
  return (
    <nav aria-label="Previous and next page" className={d.pager}>
      {prev && (
        <Link href={docsHref(prev.path)} rel="prev" className={d.pagerLink}>
          <small>Previous</small>
          {navLabel(prev)}
        </Link>
      )}
      {next && (
        <Link href={docsHref(next.path)} rel="next" className={`${d.pagerLink} ${d.pagerNext}`}>
          <small>Next</small>
          {navLabel(next)}
        </Link>
      )}
    </nav>
  );
}
