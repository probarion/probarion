import type { Metadata } from "next";
import Link from "next/link";
import c from "@/components/site/canary.module.css";
import s from "@/components/site/site.module.css";
import { ExternalLink, linePillClass } from "@/components/ui";
import { type Part, RULES_HEAD, rulesCopy } from "@/lib/canary/copy";
import { LINKS } from "@/lib/site/facts";
import { BUILD_NETWORK } from "@/lib/site/network";

export const metadata: Metadata = { title: "Canary rules" };

/** Text, and links: a web address opens in a new tab and says so, a page of this site is an app link, a mail link is a plain link. */
function Parts({ parts }: { parts: readonly Part[] }) {
  return parts.map((part, i) => {
    // The parts of a rule never change order, so the position is a stable key.
    const key = `${i}`;
    if (typeof part === "string") return <span key={key}>{part}</span>;
    if (part.href.startsWith("http")) {
      return (
        <ExternalLink key={key} href={part.href}>
          {part.text}
        </ExternalLink>
      );
    }
    // A page of this site is a link inside the app, and a mail link is a plain one.
    return part.href.startsWith("/") ? (
      <Link key={key} href={part.href}>
        {part.text}
      </Link>
    ) : (
      <a key={key} href={part.href}>
        {part.text}
      </a>
    );
  });
}

/**
 * The rules of the Canary challenge. Static: it reads no settings, only the network this build was made for. Every
 * number in it comes from CANARY_LIMITS (lib/canary/copy.ts), and every link goes to a page that exists.
 */
export default function CanaryRules() {
  const rules = rulesCopy(BUILD_NETWORK, LINKS.security);
  return (
    <div className={`${s.site} ${s.wrap} ${c.page}`}>
      <p className={s.eyebrow}>{RULES_HEAD.eyebrow}</p>
      <h1 className={c.title}>{RULES_HEAD.title}</h1>
      <ol className={c.rules}>
        {rules.map((rule) => (
          <li key={rule.title}>
            <strong>{rule.title}</strong> <Parts parts={rule.body} />
          </li>
        ))}
      </ol>
      <p className={c.back}>
        <Link className={linePillClass} href="/canary">
          {RULES_HEAD.back}
        </Link>
      </p>
    </div>
  );
}
