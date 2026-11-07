import { ExternalLink } from "@/components/ui";
import { sourceUrl } from "@/lib/docs/links";
import type { DocPage } from "@/lib/docs/types";
import d from "./docs.module.css";

/**
 * "Built from <sha> · reviewed <date>", and the files the page was checked against, at that commit.
 */
export function SourceBox({ page, commit }: { page: DocPage; commit: string | null }) {
  return (
    <section className={d.source} aria-label="Source of this page">
      <p>
        Built from {commit ? <code>{commit.slice(0, 7)}</code> : "a local build"} · reviewed{" "}
        <time dateTime={page.reviewed}>{page.reviewed}</time>
      </p>
      <ul>
        {page.sources.map((path) => (
          <li key={path}>
            <ExternalLink href={sourceUrl(path, commit)} className={d.link}>
              <code>{path}</code>
            </ExternalLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
