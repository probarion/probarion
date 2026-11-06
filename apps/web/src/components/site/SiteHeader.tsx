import Link from "next/link";
import { RouteLink } from "@/components/RouteLink";
import { ExternalLink } from "@/components/ui";
import { SITE_NAV } from "@/lib/routes";
import { CONSOLE_ROUTE, HEADER_ANCHORS, HERO, LINKS, PROOF_ROUTE } from "@/lib/site/facts";
import { BrandMark } from "./BrandMark";
import { NetworkSwitch } from "./NetworkSwitch";
import { PhoneMenu } from "./PhoneMenu";
import s from "./site.module.css";

// The console and the proof page are pills in the bar. A page that is still planned (src/lib/routes.ts) is left out of
// every menu until it is built, and then it shows up here by itself.
const PILLS = [CONSOLE_ROUTE, PROOF_ROUTE];
const otherPages = SITE_NAV.filter(({ route }) => !PILLS.includes(route));

function SectionLinks() {
  return HEADER_ANCHORS.map(({ href, label }) => (
    <Link key={href} href={href}>
      {label}
    </Link>
  ));
}

function OtherPageLinks() {
  return otherPages.map(({ route, label }) => (
    <RouteLink key={route} route={route} whenPlanned="hide">
      {label}
    </RouteLink>
  ));
}

export function SiteHeader() {
  return (
    <header className={s.siteHeader}>
      <div className={s.wrap}>
        <nav aria-label="Main" className={s.nav}>
          <Link className={s.brand} href="/" aria-label="Probarion home">
            <BrandMark />
            probarion
          </Link>
          <div className={s.navLinks}>
            <SectionLinks />
            <OtherPageLinks />
            <ExternalLink href={LINKS.github}>GitHub</ExternalLink>
          </div>
          <span className={s.spacer} />
          <NetworkSwitch variant="pill" />
          <RouteLink route={PROOF_ROUTE} whenPlanned="hide" className={`${s.btn} ${s.quietSm}`}>
            Proof
          </RouteLink>
          <RouteLink
            route={CONSOLE_ROUTE}
            whenPlanned="hide"
            className={`${s.btn} ${s.solid} ${s.barConsole}`}
          >
            {HERO.openConsole}
          </RouteLink>
          <PhoneMenu
            className={s.phoneMenu}
            summaryClassName={s.menuButton}
            panelClassName={s.menuPanel}
          >
            <div className={s.wrap}>
              <SectionLinks />
              <RouteLink route={PROOF_ROUTE} whenPlanned="hide">
                Proof
              </RouteLink>
              <RouteLink route={CONSOLE_ROUTE} whenPlanned="hide">
                {HERO.openConsole}
              </RouteLink>
              <OtherPageLinks />
              <ExternalLink href={LINKS.github}>GitHub</ExternalLink>
              <NetworkSwitch variant="menu" />
            </div>
          </PhoneMenu>
        </nav>
      </div>
    </header>
  );
}
