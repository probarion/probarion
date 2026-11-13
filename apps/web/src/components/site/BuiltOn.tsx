import Link from "next/link";
import { createElement, Fragment, type ReactNode } from "react";
import { ExternalLink } from "@/components/ui";
import { BUILT_ON, type ShipCard } from "@/lib/site/facts";
import { richParts } from "@/lib/site/rich";
import { BrandMark } from "./BrandMark";
import { NearLogo } from "./NearLogo";
import { Rich } from "./Rich";
import { GithubMark, McpLogo, NpmLogo } from "./ShipLogos";
import sh from "./ships.module.css";
import s from "./site.module.css";

/** The header's mark keeps "probarion-coin"; this second mark on the page gets its own gradient id. */
const EXTENSION_MARK_GRADIENT = "probarion-coin-built-on";

/**
 * The lists say their role out loud: Tailwind's preflight sets list-style: none, and Safari's VoiceOver then drops
 * list semantics. Spread from here because Biome's noRedundantRoles reads the markup, not the stylesheet (as in
 * Compare.tsx).
 */
const LIST = { role: "list" } as const;

/** A no-break space: a link that wraps keeps its arrow on the line of its last word. */
const NBSP = "\u00a0";

/**
 * A link to the evidence: a path of this site in this tab, a full URL in a new one. Its arrow is hidden from screen
 * readers.
 */
function EvidenceLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  if (href.startsWith("/")) {
    return (
      <Link className={className} href={href}>
        {children}
        {NBSP}
        <span aria-hidden="true">→</span>
      </Link>
    );
  }
  return (
    <ExternalLink className={className} href={href}>
      {children}
      {NBSP}
      <span aria-hidden="true">↗</span>
    </ExternalLink>
  );
}

/** A check mark in the site's own line style, beside a fact that holds today. */
function CheckGlyph() {
  return (
    <svg className={s.boCheck} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 8.5l3.2 3.2L13 4.8" />
    </svg>
  );
}

/** A date in the copy, such as 2026-11-13. */
const DATE = /(\d{4}-\d{2}-\d{2})/;

/**
 * A line of copy as Rich shows it, with the pieces a line break would split kept whole: each code span
 * (`verify --online`) and each date, which a browser may otherwise break at a hyphen.
 */
function Whole({ text }: { text: string }) {
  const parts: ReactNode[] = richParts(text).flatMap((part) =>
    part.code
      ? [createElement("code", { className: sh.nowrap }, part.text)]
      : part.text
          .split(DATE)
          .map((piece, at) =>
            at % 2 === 1 ? createElement("span", { className: sh.nowrap }, piece) : piece,
          ),
  );
  return createElement(Fragment, null, ...parts.filter((p) => p !== ""));
}

/**
 * One of a card's exact names: an identifier (in backticks) in mono, with a place to break after each "/", so that
 * `io.github.probarion/probarion` breaks at its slash on a narrow card and never mid-word; a plain name (the store
 * listing's) in the sans.
 */
function ShipId({ text }: { text: string }) {
  const [part] = richParts(text);
  if (part === undefined || !part.code) return <span className={sh.shipListing}>{text}</span>;
  // Each piece is keyed by where it starts in the name; every piece after the first follows a "/".
  let start = 0;
  return (
    <code>
      {part.text.split(/(?<=\/)/).map((piece) => {
        const at = start;
        start += piece.length;
        return (
          <Fragment key={at}>
            {at > 0 && <wbr />}
            {piece}
          </Fragment>
        );
      })}
    </code>
  );
}

/**
 * A card's logo, on a row of its own at the top of the card, hidden from screen readers (the card's heading names the
 * place). npm, MCP and GitHub: the place's owner's own mark. The store's card: Probarion's mark, which is the
 * extension's own icon, right above the "Chrome extension" label; the store's logo is not used.
 */
function ShipLogo({ icon }: { icon: ShipCard["icon"] }) {
  return (
    <span className={sh.shipLogo} aria-hidden="true">
      {icon === "npm" ? (
        <NpmLogo className={sh.npmLogo} />
      ) : icon === "mcp" ? (
        <McpLogo className={sh.mcpLogo} />
      ) : icon === "github" ? (
        <GithubMark className={sh.githubMark} />
      ) : (
        <BrandMark gradientId={EXTENSION_MARK_GRADIENT} />
      )}
    </span>
  );
}

/**
 * One place to get Probarion. Five rows, shared with the other cards of its row (ships.module.css): the logo; what
 * ships there over the place's name, as the rows set a label over a name; what a visitor gets; the exact names, a list
 * named for a screen reader, with the version; and the link, a full-width row at the foot of the card.
 */
function Ship({ ship }: { ship: ShipCard }) {
  return (
    <li className={sh.ship}>
      <ShipLogo icon={ship.icon} />
      <div className={sh.shipHead}>
        <p className={sh.shipKind}>{ship.kind}</p>
        <h3 className={sh.shipName}>{ship.name}</h3>
      </div>
      <p className={sh.shipBody}>{ship.body}</p>
      <div className={sh.shipArt}>
        <ul className={sh.shipIds} aria-label={ship.idsLabel} {...LIST}>
          {ship.ids.map((id) => (
            <li key={id}>
              <ShipId text={id} />
            </li>
          ))}
        </ul>
        <p className={sh.shipMeta}>
          <Rich text={ship.meta} />
        </p>
      </div>
      <div className={sh.shipGo}>
        <EvidenceLink className={s.link} href={ship.link.href}>
          {ship.link.label}
        </EvidenceLink>
      </div>
    </li>
  );
}

/**
 * The card's last row, quieter than the two above it: the parts of the stack with no row of their own. It is a row of
 * the card (the same tracks, padding and hairline), with its label where the rows have theirs and an entry in each of
 * the other two tracks.
 */
function Stack() {
  return (
    <li className={s.boRow}>
      <p className={`${s.boLabel} ${sh.stackLabel}`}>{BUILT_ON.also.title}</p>
      <dl className={sh.stackList}>
        {BUILT_ON.also.items.map((item) => (
          <div key={item.name} className={sh.stackItem}>
            <dt className={sh.stackName}>{item.name}</dt>
            <dd className={sh.stackBody}>
              <Whole text={item.body} />
            </dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

/** The section's last lines: the trademark notices, in two blocks that part at a sentence. */
function Legal() {
  const { label, lead, notices } = BUILT_ON.trademark;
  const half = Math.ceil(notices.length / 2);
  return (
    <footer className={sh.legal}>
      <p className={sh.legalLabel}>{label}</p>
      <p className={sh.legalLead}>{lead}</p>
      <p className={sh.legalNotices}>{notices.slice(0, half).join(" ")}</p>
      <p className={sh.legalNotices}>{notices.slice(half).join(" ")}</p>
    </footer>
  );
}

export function BuiltOn() {
  return (
    <section className={`${s.section} ${s.flush}`} id={BUILT_ON.id}>
      <div className={s.wrap}>
        <div className={`${s.sectionHead} ${s.boHead}`}>
          <h2 className={s.boTitle}>{BUILT_ON.title}</h2>
          <p>{BUILT_ON.sub}</p>
        </div>
        <ul className={s.boCard} {...LIST}>
          {BUILT_ON.rows.map((row) => (
            <li key={row.id} className={s.boRow}>
              <div className={s.boWho}>
                <p className={s.boLabel}>{row.label}</p>
                <h3 className={s.boName}>
                  {row.mark === "near-logo" ? <NearLogo className={s.nearLogo} /> : row.name}
                </h3>
                <ExternalLink className={`${s.link} ${s.boDomain}`} href={row.href}>
                  {row.domain}
                  {NBSP}
                  <span aria-hidden="true">↗</span>
                </ExternalLink>
              </div>
              <div className={s.boWhat}>
                <p className={s.boBody}>{row.body}</p>
                <ul className={s.boChecks} {...LIST}>
                  {row.checks.map((check) => (
                    <li key={check} className={s.boFact}>
                      <CheckGlyph />
                      <span>
                        <Rich text={check} />
                      </span>
                    </li>
                  ))}
                </ul>
                <p className={s.boNote}>{row.note}</p>
              </div>
              <ul className={s.boLinks} {...LIST}>
                {row.links.map((l) => (
                  <li key={l.href}>
                    <EvidenceLink className={s.link} href={l.href}>
                      {l.label}
                    </EvidenceLink>
                  </li>
                ))}
              </ul>
            </li>
          ))}
          <Stack />
        </ul>
        <section className={sh.get} aria-labelledby={BUILT_ON.shipsId}>
          <h2 className={s.boTitle} id={BUILT_ON.shipsId}>
            {BUILT_ON.shipsTitle}
          </h2>
          <ul className={sh.ships} {...LIST}>
            {BUILT_ON.ships.map((ship) => (
              <Ship key={ship.id} ship={ship} />
            ))}
          </ul>
        </section>
        <Legal />
      </div>
    </section>
  );
}
