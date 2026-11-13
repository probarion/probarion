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
  "start/mainnet-payout",
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
  "trust/self-approval",
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

describe("the docs pages", () => {
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

  it("say what an extension token can do now that it queues invoices, as SECURITY.md and the threat model do", () => {
    // SECURITY.md's token row and THREAT_MODEL's known gap: the token reads and queues, only the owner's wallet-signed
    // Confirm pays, and the structure claim is the narrowed one (test/ext-structure.test.ts).
    const lines = readMdx("trust/security-model").split("\n");
    const row = lines.find((l) => l.startsWith("| **An extension token**")) ?? "";
    for (const said of [
      "a sha256 of the token and its last four characters",
      "`POST /api/ext/invoices`, at most 20 per account and network in 10 minutes",
      "where the account is an owner or an approver",
      "not a Canary vault",
      "waits for the owner's wallet-signed Confirm",
      "`sealInvoice`",
      "its own opening functions",
    ])
      expect(row, said).toContain(said);
    expect(row).not.toContain("imports nothing that pays, signs or opens a sealed key");
    expect(row).not.toMatch(/keeps only (a|its) sha256/i);
    const gap = lines.find((l) => l.startsWith("- **Extension tokens outlive")) ?? "";
    expect(gap).toContain("It reads the waiting list and can add to it");
    expect(gap).toContain(
      "It cannot pay: each invoice waits for the owner's wallet-signed Confirm",
    );
    expect(gap).not.toContain("The owner revokes it");
    const today = readMdx("start/what-works-today").replace(/\s+/g, " ");
    expect(today).toContain("`POST /api/ext/invoices` lets it queue an invoice");
    for (const page of [row, gap, today]) expect(page).not.toMatch(/extension (pays|can pay)/i);
  });
});
