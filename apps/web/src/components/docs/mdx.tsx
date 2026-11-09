import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import { ScrollRegion } from "@/components/site/ScrollRegion";
import { tableLabel } from "@/lib/docs/node-text";
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
import { DocLink, H2, H3 } from "./prose";
import { RefTable } from "./RefTable";
import { SpendChecks } from "./SpendChecks";
import { StatusTable } from "./StatusTable";
import { Steps } from "./Steps";
import { VerifierChecks } from "./VerifierChecks";

/** A table scrolls in a region named from its header row, so several tables get distinct names. */
function Table(props: ComponentProps<"table">) {
  return (
    <ScrollRegion label={tableLabel(props.children)} className={d.tableWrap}>
      <table {...props} />
    </ScrollRegion>
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
