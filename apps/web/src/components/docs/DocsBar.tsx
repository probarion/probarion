import Link from "next/link";
import { PhoneMenu } from "@/components/site/PhoneMenu";
import { docsHref, type TabId, visibleTabs } from "@/lib/docs/registry";
import d from "./docs.module.css";
import { Sidebar } from "./Sidebar";

/**
 * The bar under the site header: the DOCS tag, the tabs, the search trigger and, on a phone, the
 * Contents drawer. A tab shows once its page exists, and with no tab there is no tabs nav at all.
 * The trigger is a link to the home's popular list, so it works without JavaScript; with it, the
 * search dialog (SearchDialog) opens instead.
 */
export function DocsBar({ current, path }: { current: TabId | null; path: string | null }) {
  const tabs = visibleTabs();
  return (
    <div className={d.bar}>
      <div className={d.barIn}>
        <Link href="/docs" className={d.tag}>
          Docs
        </Link>
        {tabs.length > 0 && (
          <nav aria-label="Docs sections" className={d.tabs}>
            <ul>
              {tabs.map((t) => (
                <li key={t.id}>
                  <Link
                    href={docsHref(t.path)}
                    className={d.tabLink}
                    aria-current={t.id === current ? "true" : undefined}
                  >
                    {t.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <a
          href="/docs#popular"
          data-docs-search=""
          className={d.searchTrigger}
          aria-keyshortcuts="Control+K Meta+K"
        >
          <span>Search the docs</span>
          <kbd className={d.kbd}>Ctrl K</kbd>
        </a>
        <PhoneMenu
          label="Contents"
          className={d.drawer}
          summaryClassName={d.drawerButton}
          panelClassName={d.drawerPanel}
        >
          <Sidebar current={path} label="Docs contents" />
        </PhoneMenu>
      </div>
    </div>
  );
}
