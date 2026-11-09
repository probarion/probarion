import Link from "next/link";
import { sectionOf } from "@/lib/docs/registry";
import { type DocPage, SECTION_LABELS } from "@/lib/docs/types";
import d from "./docs.module.css";

export function Breadcrumbs({ page }: { page: DocPage }) {
  const section = sectionOf(page.path);
  return (
    <nav aria-label="Breadcrumb" className={d.crumbs}>
      <ol>
        <li>
          <Link href="/docs">Docs</Link>
        </li>
        {section && <li>{SECTION_LABELS[section]}</li>}
        <li aria-current="page">{page.title}</li>
      </ol>
    </nav>
  );
}
