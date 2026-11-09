import Link from "next/link";
import type { ComponentProps } from "react";
import { ExternalLink } from "@/components/ui";
import { nodeText } from "@/lib/docs/node-text";
import d from "./docs.module.css";

/**
 * The prose overrides every docs page renders through: a heading with its "#" anchor link, and a
 * link. In a module of their own, so the MDX component map and `<Changelog />`, which that map
 * holds, both import them without a cycle.
 */

function Anchor({ id, label }: { id: string; label: string }) {
  return (
    <a className={d.anchor} href={`#${id}`} aria-label={`Link to this section: ${label}`}>
      #
    </a>
  );
}

export function H2({ id, children, ...rest }: ComponentProps<"h2">) {
  return (
    <h2 id={id} {...rest}>
      {children}
      {id && <Anchor id={id} label={nodeText(children)} />}
    </h2>
  );
}

export function H3({ id, children, ...rest }: ComponentProps<"h3">) {
  return (
    <h3 id={id} {...rest}>
      {children}
      {id && <Anchor id={id} label={nodeText(children)} />}
    </h3>
  );
}

/** MDX pages stop at H3; the changelog may use an H4. */
export function H4({ id, children, ...rest }: ComponentProps<"h4">) {
  return (
    <h4 id={id} {...rest}>
      {children}
      {id && <Anchor id={id} label={nodeText(children)} />}
    </h4>
  );
}

/** The .md twins and the llms files are route handlers: next/link would prefetch them as pages. */
const FILE_HREF = /\.(?:md|txt)(?:[?#]|$)/;

export function DocLink({ href = "", children, ...rest }: ComponentProps<"a">) {
  if (/^https?:\/\//.test(href)) {
    // ExternalLink sets its own target and rel; from Markdown only a title comes along.
    return (
      <ExternalLink href={href} title={rest.title} className={d.link}>
        {children}
      </ExternalLink>
    );
  }
  if (href.startsWith("/") && !FILE_HREF.test(href)) {
    return (
      <Link href={href} className={d.link} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={d.link} {...rest}>
      {children}
    </a>
  );
}
