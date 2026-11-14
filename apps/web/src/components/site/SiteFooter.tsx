import Link from "next/link";
import { Fragment } from "react";
import { RouteLink } from "@/components/RouteLink";
import { FOOTER } from "@/lib/site/facts";
import { BrandMark } from "./BrandMark";
import f from "./footer.module.css";
import { Away } from "./parts";
import s from "./site.module.css";

/*
 * The site footer, on every page (app/layout.tsx). Reading order and tab order: who this is (the wordmark and the
 * motto), the three link groups (Product, Developers, Follow), then, under a hairline, the beta and license note and
 * the legal pages in their own nav. The two rows share one grid (footer.module.css), so the note sits under the motto
 * and the legal links start where Product starts.
 */

/** The motto's two sentences, each with its period, one per line. */
const MOTTO = FOOTER.motto.split(/(?<=\.)\s+/);
/** The note around its license words: what comes before them, and what follows (the closing period). */
const [NOTE_BEFORE = "", NOTE_AFTER = ""] = FOOTER.note.split(FOOTER.license.label);

/*
 * ↗ marks a link that leaves this site; a link to a page of this site has none. The arrow is the page's one (parts.tsx
 * Away): glued to the label's last word, so that it never wraps onto a line by itself, hidden from screen readers, and
 * inside ExternalLink's children, so that its "(opens in a new tab)" is still read last.
 */

export function SiteFooter() {
  return (
    <footer className={f.footer}>
      <div className={s.wrap}>
        <div className={f.top}>
          <div>
            <Link className={`${s.brand} ${f.brand}`} href="/" aria-label="Probarion home">
              <BrandMark gradientId="probarion-coin-footer" />
              probarion
            </Link>
            {/* A space between the two lines, so that a copy or a screen reader reads "data. The contract". */}
            <p className={f.motto}>
              {MOTTO.map((line, i) => (
                <Fragment key={line}>
                  {i > 0 ? " " : null}
                  <span>{line}</span>
                </Fragment>
              ))}
            </p>
          </div>
          <nav aria-label="Footer" className={f.groups}>
            <div className={f.product}>
              <h2>Product</h2>
              <ul>
                {FOOTER.product.map(({ route, label }) => (
                  <li key={route}>
                    <RouteLink route={route}>{label}</RouteLink>
                  </li>
                ))}
              </ul>
            </div>
            <div className={f.dev}>
              <h2>Developers</h2>
              <ul>
                {FOOTER.developers.map(({ href, label }) => (
                  <li key={href}>
                    <Away href={href} label={label} className={null} />
                  </li>
                ))}
              </ul>
            </div>
            <div className={f.follow}>
              <h2>Follow</h2>
              <ul>
                {FOOTER.follow.map(({ href, label }) => (
                  <li key={href}>
                    <Away href={href} label={label} className={null} />
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        </div>
        <div className={f.base}>
          <p className={f.note}>
            {NOTE_BEFORE}
            <Away href={FOOTER.license.href} label={FOOTER.license.label} className={null} />
            {NOTE_AFTER}
          </p>
          <nav aria-label="Legal" className={f.legal}>
            <ul>
              {FOOTER.legal.map(({ route, label }) => (
                <li key={route}>
                  <RouteLink route={route}>{label}</RouteLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  );
}
