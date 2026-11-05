import { RouteLink } from "@/components/RouteLink";
import { ExternalLink } from "@/components/ui";
import { FOOTER } from "@/lib/site/facts";
import s from "./site.module.css";

export function SiteFooter() {
  return (
    <footer className={s.footer}>
      <div className={`${s.wrap} ${s.foot}`}>
        <div>
          <p>{FOOTER.motto}</p>
          <p className={s.footNote}>{FOOTER.note}</p>
        </div>
        <div>
          <h2>Product</h2>
          <ul>
            {FOOTER.product.map(({ route, label }) => (
              <li key={route}>
                <RouteLink route={route}>{label}</RouteLink>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2>Developers</h2>
          <ul>
            {FOOTER.developers.map(({ href, label }) => (
              <li key={href}>
                <ExternalLink href={href}>{label}</ExternalLink>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2>Follow</h2>
          <ul>
            {FOOTER.follow.map(({ href, label }) => (
              <li key={href}>
                <ExternalLink href={href}>{label}</ExternalLink>
              </li>
            ))}
            {FOOTER.legal.map(({ route, label }) => (
              <li key={route}>
                <RouteLink route={route}>{label}</RouteLink>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
