import Link from "next/link";
import type { ReactNode } from "react";
import { LinkPending } from "@/components/pending/LinkPending";
import { isBuilt } from "@/lib/routes";

/**
 * A link to a page of this site. While the page is still planned (`PLANNED_ROUTES`), the link is not
 * clickable: it shows as plain text marked "coming soon", or is left out with `whenPlanned="hide"` (menus).
 * `route` is the `src/app` pattern, `href` the concrete address (it defaults to `route`). While the page it opens
 * loads, LinkPending draws the route bar; idle, it adds nothing to the link.
 */
export function RouteLink({
  route,
  href = route,
  whenPlanned = "label",
  className,
  "aria-current": ariaCurrent,
  children,
}: {
  route: string;
  href?: string;
  whenPlanned?: "label" | "hide";
  className?: string;
  /** "page" on the link to the page this is (a tab that is open). */
  "aria-current"?: "page";
  children: ReactNode;
}) {
  if (isBuilt(route)) {
    return (
      <Link href={href} className={className} aria-current={ariaCurrent}>
        {children}
        <LinkPending />
      </Link>
    );
  }
  if (whenPlanned === "hide") return null;
  return (
    <span className="text-mute" title="Not built yet">
      {children} (coming soon)
    </span>
  );
}
