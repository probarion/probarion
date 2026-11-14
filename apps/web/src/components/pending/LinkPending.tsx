"use client";

import { useLinkStatus } from "next/link";

/**
 * The route bar's switch. Put it as the last child inside a `<Link>`: while that link's navigation is pending it renders
 * a hidden mark, and globals.css's `body:has([data-link-pending])` draws one 2px bar at the top of the page, after the
 * 200 ms gate. The bar is a pseudo-element, so a screen reader never meets it; Next's route announcer reads the
 * arrival. Idle, it renders nothing, so the link's markup is unchanged. It reads next/link's status only, no
 * next/navigation hook, so a test that mocks usePathname alone keeps working.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return pending ? <span data-link-pending="" hidden /> : null;
}
