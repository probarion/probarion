"use client";

import { usePathname } from "next/navigation";
import { RouteLink } from "@/components/RouteLink";
import { VAULT_TABS } from "@/lib/routes";

/**
 * Whether the tab at `path` (under the vault's `base` address) is the page open at `pathname`. The overview is only
 * the vault's own address; any other tab also covers the pages under it (a payable under Payables).
 */
export function isCurrentTab(pathname: string | null, base: string, path: string): boolean {
  if (!pathname) return false;
  const here = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const href = `${base}${path}`;
  return path === "" ? here === href : here === href || here.startsWith(`${href}/`);
}

// Each tab is a 44px target, all at one weight so switching tabs moves nothing. The open one is ink with an ink
// underline, drawn over the nav's hairline; the others are muted. One row: on a phone it scrolls sideways.
const tab = "inline-flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-2";
// Forced colours drop the colours and show a transparent border: the open tab takes the selection colour, the others
// the page colour, so only the open one is underlined there too.
const openTab = `${tab} border-ink text-ink forced-colors:border-[Highlight]`;
const otherTab = `${tab} border-transparent text-mute hover:text-ink forced-colors:border-[Canvas]`;

// A tab whose page is not built yet (see PLANNED_ROUTES) is left out until it lands.
export function VaultNav({ vault }: { vault: string }) {
  const pathname = usePathname();
  const base = `/console/${encodeURIComponent(vault)}`;
  return (
    <nav
      aria-label="Vault"
      className="mb-6 flex gap-x-2 overflow-x-auto text-sm shadow-[inset_0_-1px_0_var(--color-line)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {VAULT_TABS.map(({ path, label, isNew }) => {
        const open = isCurrentTab(pathname, base, path);
        return (
          <RouteLink
            key={path}
            route={`/console/[vault]${path}`}
            href={`${base}${path}`}
            whenPlanned="hide"
            className={open ? openTab : otherTab}
            aria-current={open ? "page" : undefined}
          >
            {label}
            {isNew ? (
              <span
                aria-hidden="true"
                className="ml-1 text-xs font-semibold tracking-[.08em] text-gold-ink uppercase"
              >
                new
              </span>
            ) : null}
          </RouteLink>
        );
      })}
      <RouteLink
        route="/proof/[vault]"
        href={`/proof/${encodeURIComponent(vault)}`}
        whenPlanned="hide"
        className={otherTab}
      >
        Proof ↗
      </RouteLink>
    </nav>
  );
}
