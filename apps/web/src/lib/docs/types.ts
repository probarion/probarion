/**
 * The docs registry's vocabulary. Every word a chip, a tab, a filter or the sidebar shows comes
 * from these lists, so a page cannot invent a status word or a section.
 */

export const SECTIONS = [
  "start",
  "concepts",
  "console",
  "build",
  "trust",
  "operate",
  "resources",
] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABELS: Readonly<Record<Section, string>> = {
  start: "Start here",
  concepts: "Concepts",
  console: "Use the console",
  build: "Build",
  trust: "Verify and trust",
  operate: "Operate",
  resources: "Resources",
};

/** The Diataxis mode, plus "hub" for the docs home. */
export const DOC_TYPES = ["hub", "tutorial", "how-to", "explanation", "reference"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABELS: Readonly<Record<DocType, string>> = {
  hub: "Overview",
  tutorial: "Tutorial",
  "how-to": "How-to",
  explanation: "Explanation",
  reference: "Reference",
};

export const AUDIENCES = [
  "beginner",
  "user",
  "developer",
  "builder",
  "partner",
  "evaluator",
  "agent",
] as const;
export type Audience = (typeof AUDIENCES)[number];

export const AUDIENCE_LABELS: Readonly<Record<Audience, string>> = {
  beginner: "Beginners",
  user: "Owners and approvers",
  developer: "Developers",
  builder: "Builders",
  partner: "Partners",
  evaluator: "Evaluators",
  agent: "AI agents",
};

/**
 * Live: works in this deployment. Preview: built, not yet run end to end or not open. Planned:
 * not built.
 */
export const FEATURE_STATUSES = ["live", "preview", "planned"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export const STATUS_LABELS: Readonly<Record<FeatureStatus, "Live" | "Preview" | "Planned">> = {
  live: "Live",
  preview: "Preview",
  planned: "Planned",
};

export const DOC_NETWORKS = ["testnet", "mainnet", "both"] as const;
export type DocNetwork = (typeof DOC_NETWORKS)[number];

/** The network chips a page shows. "both" is two chips; no other word reaches a network chip. */
export const NETWORK_CHIPS: Readonly<Record<DocNetwork, readonly ("Testnet" | "Mainnet")[]>> = {
  testnet: ["Testnet"],
  mainnet: ["Mainnet"],
  both: ["Testnet", "Mainnet"],
};

export interface DocPage {
  /** "" for the docs home, else "<section>/<slug>". The page is at /docs/<path>. */
  path: string;
  title: string;
  /** A shorter label for the sidebar and the pager, when the title is long. */
  nav?: string;
  /** 50 to 160 characters: the meta description, the search result and the llms.txt line. */
  description: string;
  /** One or two sentences shown under the H1. */
  lede: string;
  type: DocType;
  audiences: readonly Audience[];
  /** Required for tutorials and how-tos. The hub and pure reference pages may have none. */
  status?: FeatureStatus;
  network?: DocNetwork;
  /** Repo-relative paths of the code this page was checked against. Each one must exist. */
  sources: readonly string[];
  /** YYYY-MM-DD: the day the page was last checked against its sources. */
  reviewed: string;
  phase: 1 | 2 | 3;
  locale: "en";
}
