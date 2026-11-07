import { mdHref } from "@/lib/docs/registry";
import { AUDIENCE_LABELS, DOC_TYPE_LABELS, type DocPage, NETWORK_CHIPS } from "@/lib/docs/types";
import { CopyButton } from "./CopyButton";
import { NetworkChip, StatusChip } from "./chips";
import d from "./docs.module.css";

/**
 * H1, lede, then the chip row (status, network, type, audiences, reading time) and the page
 * actions. The Markdown link's name starts with its visible text: ".md (this page as Markdown)".
 */
export function PageHead({
  page,
  minutes,
  markdown,
}: {
  page: DocPage;
  minutes: number;
  markdown: string;
}) {
  return (
    <header className={d.head}>
      <h1 className={d.title}>{page.title}</h1>
      <p className={d.lede}>{page.lede}</p>
      <div className={d.meta}>
        {page.status && <StatusChip status={page.status} />}
        {page.network &&
          NETWORK_CHIPS[page.network].map((n) => <NetworkChip key={n} network={n} />)}
        <span>{DOC_TYPE_LABELS[page.type]}</span>
        <span>For {page.audiences.map((a) => AUDIENCE_LABELS[a]).join(", ")}</span>
        <span>{minutes} min read</span>
        <span className={d.spacer} />
        <CopyButton text={markdown} label="Copy page" className={d.metaButton} />
        <a href={mdHref(page.path)} className={d.metaButton}>
          .md<span className="sr-only"> (this page as Markdown)</span>
        </a>
      </div>
    </header>
  );
}
