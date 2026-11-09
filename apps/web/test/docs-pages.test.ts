import type { Code, Root, RootContent } from "mdast";
import { describe, expect, it } from "vitest";
import { headingsOf } from "@/lib/docs/headings";
import { attrOf, childrenOf, jsxNodes, parseMdx } from "@/lib/docs/mdast";
import { findPage, PAGES, pageFile } from "@/lib/docs/registry";
import { CLI_SETUP_LINES } from "@/lib/proof/cli";
import { readMdx } from "./docs-helpers";

const fileOf = (path: string) => `content/docs/${pageFile(path)}.mdx`;

/** Every fenced block in the tree, in document order, inside JSX and list items too. */
function codesOf(tree: Root): Code[] {
  const out: Code[] = [];
  const visit = (node: Root | RootContent) => {
    if (node.type === "code") out.push(node);
    for (const child of childrenOf(node)) visit(child);
  };
  visit(tree);
  return out;
}

/** The pages of spec §4 that exist, in reading order. A later page joins with its content. */
const IN_ORDER = [
  "",
  "start/what-is-probarion",
  "start/how-one-payment-works",
  "start/evaluate-in-5-minutes",
  "start/owner-quickstart",
  "start/developer-quickstart",
  "start/testnet-and-mainnet",
  "start/what-works-today",
  "concepts/vaults-roles-and-keys",
  "concepts/why-spend-has-no-payee",
  "concepts/mandates",
  "concepts/payment-checks",
  "concepts/holds-and-approvals",
  "concepts/ledger-and-anchors",
  "build/install",
  "build/let-an-agent-pay",
  "build/spend-outcomes",
  "build/errors",
  // Phase 2, cut by the OWNER on 2026-11-09 to the reference pages.
  "build/sdk-reference",
  "build/policy-rules",
  "build/cli-reference",
  "build/contract-reference",
  "build/events",
  "build/http-api",
  "build/limits-and-costs",
  "trust/verify-a-vault",
  "trust/verifier-checks",
  "trust/security-model",
  "trust/reproducible-builds",
  "operate/architecture",
  "resources/glossary",
  "resources/for-ai-agents",
  "resources/changelog",
];

/** Flows not yet run end to end with real wallets (spec §13.7). Check again after T18. */
const PREVIEW = [
  "start/owner-quickstart",
  "start/developer-quickstart",
  "concepts/holds-and-approvals",
  "concepts/ledger-and-anchors",
  "build/let-an-agent-pay",
];

describe("the phase-1 docs", () => {
  it("are the pages of the spec, in reading order", () => {
    expect(PAGES.map((p) => p.path)).toEqual(IN_ORDER);
  });

  it("parse as MDX, and a page that does not names its file", () => {
    for (const p of PAGES) expect(() => parseMdx(readMdx(p.path)), fileOf(p.path)).not.toThrow();
  });

  it("mark as Preview the flows not yet run with real wallets", () => {
    for (const path of PREVIEW) expect(findPage(path)?.status, path).toBe("preview");
  });

  it("keep the contract's checks as the first source of the payment-checks page", () => {
    expect(findPage("concepts/payment-checks")?.sources[0]).toBe("contracts/vault/src/checks.rs");
  });

  it("render the generated tables where a reader looks for them", () => {
    for (const kind of ["vault", "sdk", "http"]) {
      expect(readMdx("build/errors")).toContain(`<ErrorCatalog kind="${kind}" />`);
    }
    expect(readMdx("concepts/payment-checks")).toContain("<SpendChecks />");
    expect(readMdx("trust/verifier-checks")).toContain("<VerifierChecks />");
    expect(readMdx("start/what-works-today")).toContain("<StatusTable />");
    expect(readMdx("resources/for-ai-agents")).toContain("<AgentRules />");
  });

  it("show the install steps exactly as the site does", () => {
    const codes = codesOf(parseMdx(readMdx("build/install")));
    const setup = CLI_SETUP_LINES.join("\n");
    expect(
      codes.some((c) => c.lang === "bash" && c.value === setup),
      fileOf("build/install"),
    ).toBe(true);
  });

  it("keep the search box on the docs home and leave the doors' heading to HubDoors", () => {
    const home = readMdx("");
    expect(home).toContain("<HubSearch");
    expect(headingsOf(home).map((h) => h.id)).not.toContain("choose-a-path");
  });

  it("give the docs home four doors, the first one to the one-payment page", () => {
    const hrefs = jsxNodes(parseMdx(readMdx("")))
      .filter((n) => n.name === "Door")
      .map((n) => attrOf(n, "href", fileOf("")));
    expect(hrefs).toHaveLength(4);
    expect(hrefs[0]).toBe("/docs/start/how-one-payment-works");
  });
});
