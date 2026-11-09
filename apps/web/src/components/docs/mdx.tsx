import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import type { ComponentProps } from "react";
import { ScrollRegion } from "@/components/site/ScrollRegion";
import { ExternalLink } from "@/components/ui";
import { nodeText, tableLabel } from "@/lib/docs/node-text";
import { AgentRules } from "./AgentRules";
import { ArchitectureDiagram } from "./ArchitectureDiagram";
import { Callout } from "./Callout";
import { Changelog } from "./Changelog";
import { CodeBlock } from "./CodeBlock";
import { CodeFrame } from "./CodeFrame";
import { CodeTabs } from "./CodeTabs";
import d from "./docs.module.css";
import { ErrorCatalog } from "./ErrorCatalog";
import { Flow } from "./Flow";
import { Card, Door, HubAgents, HubCards, HubDoors, HubSearch } from "./hub";
import { RefTable } from "./RefTable";
import { SpendChecks } from "./SpendChecks";
import { StatusTable } from "./StatusTable";
import { Steps } from "./Steps";
import { VerifierChecks } from "./VerifierChecks";

function Anchor({ id, label }: { id: string; label: string }) {
  return (
    <a className={d.anchor} href={`#${id}`} aria-label={`Link to this section: ${label}`}>
      #
    </a>
  );
}

function H2({ id, children, ...rest }: ComponentProps<"h2">) {
  return (
    <h2 id={id} {...rest}>
      {children}
      {id && <Anchor id={id} label={nodeText(children)} />}
    </h2>
  );
}

function H3({ id, children, ...rest }: ComponentProps<"h3">) {
  return (
    <h3 id={id} {...rest}>
      {children}
      {id && <Anchor id={id} label={nodeText(children)} />}
    </h3>
  );
}

/** A table scrolls in a region named from its header row, so several tables get distinct names. */
function Table(props: ComponentProps<"table">) {
  return (
    <ScrollRegion label={tableLabel(props.children)} className={d.tableWrap}>
      <table {...props} />
    </ScrollRegion>
  );
}

/** The .md twins and the llms files are route handlers: next/link would prefetch them as pages. */
const FILE_HREF = /\.(?:md|txt)(?:[?#]|$)/;

function DocLink({ href = "", children, ...rest }: ComponentProps<"a">) {
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

/**
 * The prose overrides and the components MDX pages may use. markdown.ts has a handler for each
 * component.
 */
export const DOCS_COMPONENTS: MDXComponents = {
  h2: H2,
  h3: H3,
  pre: CodeFrame,
  table: Table,
  a: DocLink,
  Callout,
  Steps,
  Flow,
  CodeTabs,
  CodeBlock,
  ErrorCatalog,
  SpendChecks,
  VerifierChecks,
  StatusTable,
  AgentRules,
  RefTable,
  Changelog,
  ArchitectureDiagram,
  HubSearch,
  HubDoors,
  Door,
  HubCards,
  Card,
  HubAgents,
};
