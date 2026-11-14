import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Code, Root, RootContent } from "mdast";
import { describe, expect, it } from "vitest";
import { headingsOf } from "@/lib/docs/headings";
import { attrOf, childrenOf, jsxNodes, parseMdx } from "@/lib/docs/mdast";
import { findPage, PAGES, pageFile } from "@/lib/docs/registry";
import { CLI_SETUP_LINES } from "@/lib/proof/cli";
import { COMPARE, CONSOLE_SHOTS, LINKS, STATUS, statusOf, TX } from "@/lib/site/facts";
import { readMdx, WEB } from "./docs-helpers";

const fileOf = (path: string) => `content/docs/${pageFile(path)}.mdx`;

/** A page's lines under `heading`, up to the next heading of the same depth or higher. */
function sectionOf(path: string, heading: string): string {
  const lines = readMdx(path).split("\n");
  const at = lines.indexOf(heading);
  if (at < 0) throw new Error(`${fileOf(path)}: no "${heading}"`);
  const depth = heading.indexOf(" ");
  const end = lines.findIndex((l, i) => i > at && /^#{2,3} /.test(l) && l.indexOf(" ") <= depth);
  return lines.slice(at + 1, end < 0 ? undefined : end).join("\n");
}

/** A Markdown line with its links turned into their labels and its bold marks dropped, as a reader reads it. */
const plain = (line: string) => line.replaceAll("**", "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

/**
 * The known gap that leaves STATUS.gaps in its own change (feat/testing-numbers). The docs list never carried it, so
 * the check below skips it while the landing still has it.
 */
const GAP_LEAVING = "No outside users yet.";

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

/**
 * Flows not yet run end to end as written (spec §13.7). Holds and approvals and the ledger left this list on
 * 2026-11-13, once their runs were recorded (test/docs-status-labels.test.ts).
 */
const PREVIEW = ["start/owner-quickstart", "start/developer-quickstart", "build/let-an-agent-pay"];

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

// On 2026-11-14 the landing went from 14 sections to 7, and the reference material it dropped moved to these
// headings. Each one is held to the constant the landing rendered it from, so the two cannot drift apart.
describe("the material the landing moved to the docs", () => {
  it("compares a limit contract with Probarion row for row, each status the pill of its row", () => {
    const section = sectionOf("start/what-is-probarion", "## Why not a spending-limit contract");
    expect(section).toContain(`${COMPARE.title} ${COMPARE.sub}`);
    const [, diy, probarion, status] = COMPARE.head;
    for (const g of COMPARE.groups) {
      const rows = COMPARE.rows
        .filter((r) => r.group === g.id)
        .map((r) => {
          const s = statusOf(r.status);
          return `| ${r.question} | ${r.diy} | ${r.probarion} | [${s.pill}](/docs/start/what-works-today#${s.id}) |`;
        });
      // The group's label heads its table's first column, so each table's scroll region has its own name.
      const table = [
        `| ${g.label} | ${diy} | ${probarion} | ${status} |`,
        "| --- | --- | --- | --- |",
      ];
      expect(section, g.label).toContain([...table, ...rows].join("\n"));
    }
    expect(section).toContain(`[${COMPARE.more.label}](${COMPARE.more.href})`);
    const h2 = headingsOf(readMdx("start/what-is-probarion")).filter((h) => h.depth === 2);
    const at = h2.findIndex((h) => h.id === "why-not-a-spending-limit-contract");
    expect(h2[at + 1]?.text).toBe("Where to go next");
  });

  it("list the known gaps the landing renders, list by list, in the landing's words", () => {
    const path = "start/what-works-today";
    const heads = headingsOf(readMdx(path));
    const at = heads.findIndex((h) => h.id === STATUS.gaps.id);
    expect(heads[at]?.depth).toBe(2);
    expect(heads.slice(at + 1, at + 1 + STATUS.gaps.lists.length).map((h) => h.text)).toEqual(
      STATUS.gaps.lists.map((l) => l.title),
    );
    const { sub } = STATUS.gaps;
    expect(sectionOf(path, `## ${STATUS.gaps.title}`)).toContain(
      sub.slice(0, sub.indexOf(".") + 1),
    );
    for (const list of STATUS.gaps.lists) {
      const items = sectionOf(path, `### ${list.title}`)
        .split("\n")
        .filter((l) => l.startsWith("- **"));
      const want = list.items.filter((i) => i.lead !== GAP_LEAVING);
      expect(
        items.map((l) => /^- \*\*(.+?)\*\* /.exec(l)?.[1]),
        list.id,
      ).toEqual(want.map((i) => i.lead));
      for (const [n, item] of want.entries()) {
        const words = item.parts.map((p) => (typeof p === "string" ? p : p.label)).join("");
        expect(plain(items[n] ?? "").startsWith(`- ${item.lead} ${words}`), item.lead).toBe(true);
      }
    }
  });

  it("show the console's held, invoice and paid shots on holds and approvals, each with its transaction", () => {
    const section = sectionOf("concepts/holds-and-approvals", "## A hold in the console");
    expect(section).toContain("INV-2004, 4 test USDC, above its mandate's 3 USDC approval limit");
    let last = -1;
    for (const shot of CONSOLE_SHOTS.shots) {
      expect(existsSync(join(WEB, "public", ...shot.src.split("/"))), shot.src).toBe(true);
      const image = new RegExp(`!\\[([^\\]]{40,})\\]\\(${shot.src.replace(/[.]/g, "\\.")}\\)`);
      const at = section.search(image);
      expect(at, shot.id).toBeGreaterThan(last);
      last = at;
      const title = section.indexOf(`**${shot.title}.**`);
      expect(title, shot.title).toBeGreaterThanOrEqual(0);
      expect(title, shot.title).toBeLessThan(at);
      if (shot.link !== undefined) {
        const [verb, label] = shot.link.label.split(" ");
        expect(section, shot.id).toContain(`${verb} [\`${label}\`](${shot.link.url})`);
      }
    }
    expect(section).toContain(`[proof page](${CONSOLE_SHOTS.proof.href})`);
  });

  it("keep the smoke run's three testnet transactions under See it on testnet", () => {
    const section = sectionOf("start/how-one-payment-works", "## See it on testnet");
    for (const t of [TX.nearPayment, TX.baseBurn, TX.noMandate]) {
      expect(section, t.label).toContain(`[\`${t.label}\`](${t.url})`);
    }
  });

  it("name the MCP Registry entry by the npm install, with the registry's search for it", () => {
    const section = sectionOf("build/install", "## Install from npm");
    expect(section).toContain(
      `(${LINKS.mcpRegistry}) lists it as \`io.github.probarion/probarion\``,
    );
  });
});
