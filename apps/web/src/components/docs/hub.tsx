import Link from "next/link";
import type { ReactNode } from "react";
import { docsHref, findPage, mdHref } from "@/lib/docs/registry";
import type { DocPage } from "@/lib/docs/types";
import d from "./docs.module.css";

/**
 * The docs home's claim, from the mockup. The registry title stays "Probarion docs" and is the
 * eyebrow.
 */
export const HUB_CLAIM = { plain: "Give an AI agent a budget,", gold: "not your keys." } as const;

export function HubHero({ page }: { page: DocPage }) {
  return (
    <header className={d.hero}>
      <p className={d.eyebrow}>{page.title}</p>
      <h1 className={d.heroTitle}>
        {HUB_CLAIM.plain} <span className={d.gold}>{HUB_CLAIM.gold}</span>
      </h1>
      <p className={d.heroLede}>{page.lede}</p>
    </header>
  );
}

/**
 * The big search box and the popular searches. Without JavaScript the box jumps to the list, and
 * each popular search is a link to the page that answers it. With JavaScript the box opens the
 * search dialog, and a popular search opens it with that query (SearchDialog listens for both).
 */
export function HubSearch({ children }: { children: ReactNode }) {
  return (
    <div className={d.hubSearch}>
      <a
        href="#popular"
        data-docs-search=""
        className={d.bigSearch}
        aria-keyshortcuts="Control+K Meta+K"
      >
        <span>Search pages, error codes and CLI commands</span>
        {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a kbd is never focusable, and the
            link's aria-keyshortcuts names the shortcut */}
        <kbd className={d.kbd} aria-hidden="true">
          Ctrl K
        </kbd>
      </a>
      <div id="popular" className={d.popular} data-docs-popular="">
        <p>Popular searches</p>
        {children}
      </div>
    </div>
  );
}

/** The four doors. Their heading is for the page outline and only screen readers show it. */
export function HubDoors({ children }: { children: ReactNode }) {
  return (
    <section className={d.doorsWrap} aria-labelledby="choose-a-path">
      <h2 id="choose-a-path" className="sr-only">
        Choose a path
      </h2>
      <div className={d.doors}>{children}</div>
    </section>
  );
}

function required(component: string, name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") throw new Error(`<${component}> needs ${name}`);
  return value;
}

/**
 * One door. The title is the link and the whole card is its click target; `also` adds a second,
 * smaller link.
 */
export function Door({
  who,
  title,
  href,
  go,
  also,
  alsoHref,
  ink = false,
  children,
}: {
  who: string;
  title: string;
  href: string;
  go: string;
  also?: string;
  alsoHref?: string;
  ink?: boolean;
  children: ReactNode;
}) {
  if ((also === undefined) !== (alsoHref === undefined)) {
    throw new Error(`<Door> "${title}": also and alsoHref go together`);
  }
  return (
    <article className={`${d.door} ${ink ? d.doorInk : ""}`} data-door="">
      <p className={d.who}>{required("Door", "who", who)}</p>
      <h3 className={d.doorTitle}>
        <Link href={required("Door", "href", href)} className={d.cover}>
          {required("Door", "title", title)}
        </Link>
      </h3>
      <div className={d.doorText}>{children}</div>
      <p className={d.go}>
        <span aria-hidden="true">{required("Door", "go", go)} →</span>
        {also !== undefined && alsoHref !== undefined && (
          <Link href={alsoHref} className={d.also}>
            {also}
          </Link>
        )}
      </p>
    </article>
  );
}

export function HubCards({ children }: { children: ReactNode }) {
  return <div className={d.cards}>{children}</div>;
}

/**
 * A card in a grid: the title is the link, the whole card is its click target, and `tag` shows as
 * code.
 */
export function Card({
  title,
  href,
  tag,
  children,
}: {
  title: string;
  href: string;
  tag?: string;
  children: ReactNode;
}) {
  return (
    <article className={d.card}>
      <h3 className={d.cardTitle}>
        <Link href={required("Card", "href", href)} className={d.cover}>
          {required("Card", "title", title)}
        </Link>
      </h3>
      <div className={d.cardText}>{children}</div>
      {tag !== undefined && (
        <p className={d.cardTag}>
          <code>{tag}</code>
        </p>
      )}
    </article>
  );
}

/** The ink block for agent builders: the two llms files and one page's Markdown twin. */
export function HubAgents({ example }: { example: string }) {
  const page = findPage(example);
  if (!page) throw new Error(`HubAgents: no docs page "${example}"`);
  const forAgents = findPage("resources/for-ai-agents");
  return (
    <div className={d.agents}>
      <p className={d.agentsEyebrow}>For AI agents and their builders</p>
      <p>
        Every page is also plain Markdown. Point a coding agent at the index, or paste a page into a
        chat.
      </p>
      <ul className={d.agentsLinks}>
        <li>
          <a href="/llms.txt">
            <code>/llms.txt</code>
          </a>{" "}
          the index
        </li>
        <li>
          <a href="/llms-full.txt">
            <code>/llms-full.txt</code>
          </a>{" "}
          every page in one file
        </li>
        <li>
          <a href={mdHref(page.path)}>
            <code>{mdHref(page.path)}</code>
          </a>{" "}
          one page
        </li>
      </ul>
      {forAgents && (
        <p>
          <Link href={docsHref(forAgents.path)} className={d.agentsMore}>
            For AI agents
          </Link>
        </p>
      )}
    </div>
  );
}
