import Link from "next/link";
import { docsHref, groupTitleId, navLabel, sidebarGroups } from "@/lib/docs/registry";
import d from "./docs.module.css";

/** The docs contents. A Preview page has a dot and says so to screen readers. */
export function Sidebar({ current, label = "Docs" }: { current: string | null; label?: string }) {
  const where = label === "Docs" ? "side" : "drawer";
  return (
    <nav aria-label={label} className={d.sideNav}>
      <ul>
        <li>
          <Link
            href="/docs"
            className={d.sideLink}
            aria-current={current === "" ? "page" : undefined}
          >
            Docs home
          </Link>
        </li>
      </ul>
      {sidebarGroups().map((g) => (
        <div key={g.section} className={d.group}>
          <p className={d.groupTitle} id={groupTitleId(where, g.section)}>
            {g.label}
          </p>
          <ul aria-labelledby={groupTitleId(where, g.section)}>
            {g.pages.map((p) => (
              <li key={p.path}>
                <Link
                  href={docsHref(p.path)}
                  className={d.sideLink}
                  aria-current={p.path === current ? "page" : undefined}
                >
                  {navLabel(p)}
                  {p.status === "preview" && (
                    <>
                      <span className={d.dotPreview} aria-hidden="true" />
                      <span className="sr-only"> (Preview)</span>
                    </>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
