import Link from "next/link";
import { docsHref, groupTitleId, navLabel, sidebarGroups } from "@/lib/docs/registry";
import { CurrentInView } from "./CurrentInView";
import d from "./docs.module.css";

/** The legend under the groups: the docs' own definition of Preview (start/what-works-today). */
export const PREVIEW_LEGEND = "Preview: built, not yet run end to end";

/**
 * The docs contents. A Preview page has a dot and says so to screen readers, and a legend under
 * the groups says what the dot means. `where` says which copy this is (the desktop column or the
 * phone drawer), so the two copies' group ids differ. CurrentInView keeps the current page's link
 * in view in either copy.
 */
export function Sidebar({
  current,
  where,
  label = "Docs",
}: {
  current: string | null;
  where: "side" | "drawer";
  label?: string;
}) {
  return (
    <nav aria-label={label} className={d.sideNav}>
      <CurrentInView current={current} />
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
      <p className={d.legend}>
        <span className={d.dotPreview} aria-hidden="true" />
        {PREVIEW_LEGEND}
      </p>
    </nav>
  );
}
