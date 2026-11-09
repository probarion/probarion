import { PhoneMenu } from "@/components/site/PhoneMenu";
import type { TocItem } from "@/lib/docs/toc-spy";
import d from "./docs.module.css";

/**
 * "On this page" as a disclosure under the breadcrumb, below 1180 px. It closes when a link is
 * followed.
 */
export function TocDrop({ items }: { items: readonly TocItem[] }) {
  return (
    <PhoneMenu
      label="On this page"
      className={d.tocDrop}
      summaryClassName={d.tocDropButton}
      panelClassName={d.tocDropPanel}
    >
      <ol className={d.tocList}>
        {items.map((i) => (
          <li key={i.id} className={i.depth === 3 ? d.tocSub : undefined}>
            <a href={`#${i.id}`} className={d.tocLink}>
              {i.text}
            </a>
          </li>
        ))}
      </ol>
    </PhoneMenu>
  );
}
