import Link from "next/link";
import type { ReactNode } from "react";
import { ExternalLink } from "@/components/ui";
import { BUILT_ON, type ShipCard } from "@/lib/site/facts";
import { BrandMark } from "./BrandMark";
import { NearLogo } from "./NearLogo";
import { Rich } from "./Rich";
import { GithubMark, McpLogo, NpmLogo } from "./ShipLogos";
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

/** A card's logo, on a row of its own above the name it shows, and hidden from screen readers with it. */
function ShipLogo({ icon }: { icon: ShipCard["icon"] }) {
  return (
    <span className={s.shipLogo} aria-hidden="true">
      {icon === "npm" ? (
        <NpmLogo className={s.npmLogo} />
      ) : icon === "mcp" ? (
        <McpLogo className={s.mcpLogo} />
      ) : icon === "github" ? (
        <GithubMark className={s.githubMark} />
      ) : (
        <BrandMark gradientId={EXTENSION_MARK_GRADIENT} />
      )}
    </span>
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
        </ul>
        <h3 className={s.shipsTitle}>{BUILT_ON.shipsTitle}</h3>
        <ul className={s.ships} {...LIST}>
          {BUILT_ON.ships.map((ship) => (
            <li key={ship.id} className={s.ship}>
              <ShipLogo icon={ship.icon} />
              <div className={s.shipHead}>
                <h4 className={s.shipName}>{ship.name}</h4>
                <span className={s.shipTag}>{ship.tag}</span>
              </div>
              <p className={s.shipBody}>
                <Rich text={ship.body} />{" "}
                <EvidenceLink className={`${s.link} ${s.shipGo}`} href={ship.link.href}>
                  {ship.link.label}
                </EvidenceLink>
              </p>
            </li>
          ))}
        </ul>
        <div className={s.boFine}>
          <p>
            <Rich text={BUILT_ON.also} />
          </p>
          <p>{BUILT_ON.trademark}</p>
        </div>
      </div>
    </section>
  );
}
