// The landing's "Built on" section (components/site/BuiltOn.tsx): what Probarion is built on, each with its evidence,
// where it ships, and the trademark notices. Every fact is held to the file it comes from, every link is checked
// offline (npmjs.com answers a script with a bot check, so nothing here fetches), and each third-party logo is held to
// its owner's file.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import { BetaStripView } from "@/components/site/BetaStrip";
import { BuiltOn } from "@/components/site/BuiltOn";
import { NearLogo } from "@/components/site/NearLogo";
import { GithubMark, McpLogo, NpmLogo } from "@/components/site/ShipLogos";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { seqAnchorId } from "@/lib/proof/decisions";
import { BUILT_ON, CLOSING, LINKS, STATUS, statusOf } from "@/lib/site/facts";
import { linkProblem } from "./docs-helpers";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "..", "..");
const text = (...p: string[]) => readFileSync(join(...p), "utf8");
const README = text(ROOT, "README.md");
const readmeRow = (start: string) => {
  const row = README.split("\n").find((l) => l.startsWith(`| ${start}`));
  expect(row, start).toBeDefined();
  return row ?? "";
};
const jsonl = (...p: string[]) =>
  text(...p)
    .trim()
    .split("\n")
    .map(
      (l) =>
        JSON.parse(l) as {
          body: {
            seq: number;
            kind: string;
            verdict?: string;
            decided_by?: string;
            evidence?: { provider: string } | null;
          };
        },
    );

const section = () => renderToStaticMarkup(createElement(BuiltOn));
/** The text a visitor reads: inline tags join their words, block tags part them. */
const visibleText = (html: string) =>
  html
    .replace(/<\/?(?:a|code|span)\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const hrefs = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1] ?? "");
const anchors = (html: string) => [...html.matchAll(/<a\s[^>]*>.*?<\/a>/g)].map((m) => m[0]);
/** Every `@media <query> {` block of a stylesheet with exactly that query, joined. */
const mediaBlocks = (css: string, query: string) => {
  const open = `@media ${query} {`;
  const blocks: string[] = [];
  for (let at = css.indexOf(open); at !== -1; at = css.indexOf(open, at + open.length))
    blocks.push(css.slice(at, css.indexOf("\n}\n", at)));
  expect(blocks.length, query).toBeGreaterThan(0);
  return blocks.join("\n");
};
/** A rule at the top level of a stylesheet, outside any @media block. */
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

/** An en dash or an em dash (by code point, so that this file holds neither). */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
/** Every string of BUILT_ON, wherever it sits. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** The words that would claim a relationship Probarion does not have. */
const CLAIM_WORDS =
  /\bpartner(s|ed|ship)?\b|\bbacked by\b|\btrusted by\b|\bsponsored by\b|\bendorsed by\b|\bpowered by\b|\bofficial partner\b/i;
/** The only two places the section may name a partnership or an endorsement: to say there is none. */
const DISCLAIMERS = [/No partnership or endorsement is implied\./g, /not to imply an endorsement/g];
const withoutDisclaimers = (s: string) => DISCLAIMERS.reduce((t, re) => t.replace(re, ""), s);

describe("the built-on section", () => {
  it("sits after the status list and before the closing, once, under its own id", () => {
    const html = renderToStaticMarkup(createElement(Home));
    const at = html.indexOf(`id="${BUILT_ON.id}"`);
    expect(BUILT_ON.id).toBe("built-on");
    expect(html.match(/id="built-on"/g)).toHaveLength(1);
    expect(at).toBeGreaterThan(html.indexOf('id="status"'));
    expect(at).toBeGreaterThan(html.indexOf(`id="${STATUS.gaps.id}"`));
    expect(at).toBeLessThan(html.indexOf(CLOSING.line2));
    // A section of the page like the status list: the same section classes, so the same spacing between sections.
    const status = /<section (class="[^"]+") id="status">/.exec(html)?.[1];
    expect(html).toContain(`<section ${status} id="built-on">`);
  });

  it("pins the two rows and the four cards, in order", () => {
    expect(BUILT_ON.title).toBe("Built on NEAR, with NEAR AI Cloud");
    expect(BUILT_ON.sub).toBe(
      "Where each payment is made, and the optional model that can advise it. No partnership or endorsement is implied.",
    );
    expect(
      BUILT_ON.rows.map(({ id, label, name, mark, domain, href }) => ({
        id,
        label,
        name,
        mark,
        domain,
        href,
      })),
    ).toEqual([
      {
        id: "near",
        label: "Where payments are made",
        name: "NEAR Protocol",
        mark: "near-logo",
        domain: "near.org",
        href: "https://near.org",
      },
      {
        id: "near-ai-cloud",
        label: "The model that advises",
        name: "NEAR AI Cloud",
        mark: "text",
        domain: "cloud.near.ai",
        href: "https://cloud.near.ai",
      },
    ]);
    for (const row of BUILT_ON.rows) expect(new URL(row.href).hostname, row.id).toBe(row.domain);
    expect(BUILT_ON.rows.map((r) => r.links.map((l) => l.href))).toEqual([
      ["/proof/demo.vaults.probarion.testnet", "/docs/start/testnet-and-mainnet#the-mainnet-vault"],
      [
        "/proof/demo.vaults.probarion.testnet#seq-13",
        "/proof/demo.vaults.probarion.testnet#seq-15",
        LINKS.demoVerifyOnline,
      ],
    ]);
    expect(BUILT_ON.shipsTitle).toBe("Ships through");
    expect(
      BUILT_ON.ships.map(({ id, name, tag, icon, link }) => ({
        id,
        name,
        tag,
        icon,
        label: link.label,
        href: link.href,
      })),
    ).toEqual([
      {
        id: "npm",
        name: "npm public registry",
        tag: "Packages",
        icon: "npm",
        label: "@probarion/sdk on npm",
        href: "https://www.npmjs.com/package/@probarion/sdk",
      },
      // Each link's name says where it goes on its own, as a screen reader's list of links reads it.
      {
        id: "mcp-registry",
        name: "Official MCP Registry",
        tag: "MCP server",
        icon: "mcp",
        label: "The MCP Registry entry",
        href: "https://registry.modelcontextprotocol.io/?q=io.github.probarion/probarion",
      },
      {
        id: "github",
        name: "GitHub",
        tag: "Source and CI",
        icon: "github",
        label: "probarion/probarion on GitHub",
        href: "https://github.com/probarion/probarion",
      },
      {
        id: "chrome-web-store",
        name: "Probarion extension",
        tag: "Chrome extension",
        icon: "probarion",
        label: "The Chrome Web Store listing",
        href: LINKS.chromeWebStore,
      },
    ]);
    // The LINKS test loop covers every address the section links outside this site.
    expect(LINKS).toMatchObject({
      npmSdk: BUILT_ON.ships[0].link.href,
      mcpRegistry: BUILT_ON.ships[1].link.href,
      github: BUILT_ON.ships[2].link.href,
      nearOrg: BUILT_ON.rows[0].href,
      nearAiCloud: BUILT_ON.rows[1].href,
    });
  });

  it("renders the rows, the checks, the cards and both notices", () => {
    const out = visibleText(section()).replace(/ \(opens in a new tab\)/g, "");
    for (const row of BUILT_ON.rows) {
      expect(out).toContain(row.label);
      expect(out).toContain(row.body);
      expect(out).toContain(row.note);
      for (const check of row.checks) expect(out).toContain(check.replace(/`/g, ""));
      for (const link of row.links) expect(out).toContain(link.label);
    }
    // NEAR's name is its logo's accessible name; NEAR AI Cloud's is set in text.
    expect(out).not.toContain("NEAR Protocol");
    expect(section()).toContain('aria-label="NEAR Protocol"');
    expect(out).toContain("The model that advises NEAR AI Cloud cloud.near.ai");
    for (const ship of BUILT_ON.ships) {
      expect(out).toContain(`${ship.name} ${ship.tag}`);
      expect(out).toContain(ship.body.replace(/`/g, ""));
      expect(out).toContain(ship.link.label);
    }
    expect(out).toContain(BUILT_ON.also.replace(/`/g, ""));
    expect(out.endsWith(BUILT_ON.trademark)).toBe(true);
    expect(out.indexOf(BUILT_ON.also.replace(/`/g, ""))).toBeLessThan(
      out.indexOf(BUILT_ON.trademark),
    );
  });
});

describe("the built-on facts", () => {
  const prose = README.replace(/\s+/g, " ");

  it("NEAR: the vault and the factory on testnet, one small vault on mainnet with a NEAR payment, two Base payouts and a refusal", () => {
    const [near] = BUILT_ON.rows;
    expect(near.body).toBe(
      "Each vault is a NEAR contract that holds its USDC and checks every payment against the owner's mandate.",
    );
    expect(prose).toContain(
      "The vault holds the USDC and checks every payment against its mandate before anything moves.",
    );
    expect(near.checks).toEqual([
      "The vault and the factory run on NEAR testnet",
      "One small vault on mainnet since 2026-11-11, `v0.probarion.near`",
      "On mainnet: a NEAR payment, two Base payouts and a refusal, all on chain",
    ]);
    expect(readmeRow("Vault contract")).toContain("**Shipped on NEAR testnet**");
    expect(readmeRow("Factory contract")).toContain("**Shipped on NEAR testnet**");
    const mainnet = readmeRow("Mainnet vault `v0.probarion.near`");
    expect(mainnet).toContain(
      "**Live on NEAR mainnet** since 2026-11-11, with real USDC and small amounts",
    );
    expect(mainnet).toContain("spend 1 paid 1 USDC");
    expect(mainnet).toContain("was refused on chain with `PROBARION:NoMandate`");
    expect(mainnet).toContain("the POA bridge released 0.9976 USDC on Base");
    expect(mainnet).toContain("1.00 USDC once, to the owner's own Base address");
    expect(mainnet).toContain("a labeled test of the cross-chain path");
    expect(mainnet).toContain("0.25 USDC once, to the same address");
    expect(mainnet).toContain("the POA bridge released 0.2476 USDC on Base");
    expect(mainnet).toContain("The ledger now holds 6 entries, anchored 4 times");
    expect(near.note).toBe(
      "Two tests to the owner's own Base address: one rules-only, one with an attested model.",
    );
    // The same words as the status list's row, which is held to the README in site-facts.test.ts.
    expect(statusOf("Mainnet vault").pill).toBe(
      "On mainnet: 3 test payments (2 to Base), 1 refused on chain",
    );
    const record = JSON.parse(text(ROOT, "contracts", "deployments", "mainnet.json")) as {
      vault_v0: { account_id: string };
    };
    expect(record.vault_v0.account_id).toBe("v0.probarion.near");
    expect(
      text(ROOT, "apps", "web", "content", "docs", "start", "testnet-and-mainnet.mdx"),
    ).toContain("## The mainnet vault");
  });

  it("NEAR AI Cloud: 7 published attested decisions that pass A1 to A7, 6 of them O1 and O2, two paid invoices, and the image not pinned", () => {
    const [, ai] = BUILT_ON.rows;
    expect(ai.body).toBe(
      "An optional private model, run in a TEE, reads the invoice and proposes. Code decides, and the contract has the last word.",
    );
    expect(ai.checks).toEqual([
      "7 published attested decisions on testnet: 2 on the Canary, 5 by Payables",
      "All 7 pass A1 to A7 offline, and 6 passed O1 and O2 online",
      "On 2026-11-12 Payables paid two invoices on its own with it: 2 test USDC each",
    ]);
    const row = readmeRow("NEAR AI Cloud adapter");
    expect(row).toContain(
      "holds 2 decisions by NEAR AI Cloud's `z-ai/glm-5.3-flash` that are attested",
    );
    expect(row).toContain("pass A1 to A7 offline and, on 2026-11-11, the online checks O1 and O2");
    expect(row).toContain(
      "The demo vault's ledger holds 5 more, made by Payables, which pass A1 to A7",
    );
    expect(row).toContain(
      "the four attested decisions the demo vault held then, entries 10 to 13, passed O1 and O2",
    );
    expect(row).toContain("the vault paid 2.00 test USDC as spend 4");
    expect(row).toContain(
      "later that day the same happened for INV-2010, which the vault paid as spend 5",
    );
    expect(row).toContain(
      "The TEE measurement is not pinned, so this does not show which model image ran",
    );
    expect(ai.note).toBe(
      "The TEE image is not pinned yet, so this does not show which model image ran.",
    );
    expect(statusOf("Live attested model run").pill).toContain("image not pinned");
    // The ledgers themselves: 2 attested decisions on the Canary, 5 on the demo vault, the last two of them allowed.
    const attested = (entries: ReturnType<typeof jsonl>) =>
      entries.filter(
        (e) => e.body.kind === "decision" && e.body.evidence?.provider === "near-ai-cloud",
      );
    expect(
      attested(jsonl(ROOT, "docs", "evidence", "canary-vault", "ledger-2026-11-10.jsonl")),
    ).toHaveLength(2);
    const demo = jsonl(ROOT, "docs", "evidence", "demo-vault", "ledger-2026-11-12-video.jsonl");
    expect(attested(demo).map((e) => e.body.seq)).toEqual([10, 11, 12, 13, 15]);
    for (const [decision, payment] of [
      [13, 14],
      [15, 16],
    ]) {
      const paid = demo.find((e) => e.body.seq === decision)?.body;
      expect(paid).toMatchObject({ kind: "decision", verdict: "allow", decided_by: "model+rules" });
      expect(demo.find((e) => e.body.seq === payment)?.body.kind).toBe("payment");
    }
    const evidence = text(ROOT, "docs", "evidence", "demo-vault", "README.md");
    expect(evidence).toContain("## 2026-11-12: Payables pays on its own with an attested model");
    expect(evidence).toContain(
      "## 2026-11-12, filmed: a second invoice paid on its own, freeze and unfreeze",
    );
    expect(text(ROOT, "docs", "evidence", "demo-vault", "verify-online-2026-11-12.txt")).toContain(
      "4 GPU payloads bound to the request nonce and verified by NRAS (O2)",
    );
  });

  it("npm, the MCP Registry, GitHub and the store: the versions the packages, server.json and the README give", () => {
    const [npm, mcp, github, store] = BUILT_ON.ships;
    expect(npm.body).toBe(
      "`probarion`, `@probarion/core`, `@probarion/sdk` and `@probarion/mcp` 0.1.1, with npm provenance.",
    );
    for (const dir of ["cli", "core", "sdk", "mcp"]) {
      const pkg = JSON.parse(text(ROOT, "packages", dir, "package.json")) as {
        name: string;
        version: string;
      };
      expect(npm.body, pkg.name).toContain(`\`${pkg.name}\``);
      expect(pkg.version, pkg.name).toBe("0.1.1");
    }
    const release = readmeRow("npm release 0.1.1");
    expect(release).toContain(
      "`@probarion/core`, `@probarion/sdk`, `probarion` and `@probarion/mcp` 0.1.1, published from the tag `sdk-v0.1.1`",
    );
    expect(release).toContain("with npm provenance");

    const server = JSON.parse(text(ROOT, "packages", "mcp", "server.json")) as {
      name: string;
      version: string;
      packages: { registryType: string; identifier: string; version: string }[];
    };
    expect(server.name).toBe("io.github.probarion/probarion");
    expect(server.version).toBe("0.1.1");
    expect(server.packages[0]).toMatchObject({
      registryType: "npm",
      identifier: "@probarion/mcp",
      version: "0.1.1",
    });
    expect(mcp.body).toBe(
      "Lists `io.github.probarion/probarion` 0.1.1, the server in `@probarion/mcp`.",
    );
    expect(new URL(LINKS.mcpRegistry).searchParams.get("q")).toBe(server.name);
    expect(release).toContain(
      "The official MCP registry lists the server as `io.github.probarion/probarion`",
    );

    // The license file, and the CI workflow with its sandbox and reproducible-build jobs.
    expect(github.body).toBe(
      "The MIT source, and the CI that runs the sandbox tests and the reproducible build.",
    );
    expect(text(ROOT, "LICENSE").startsWith("MIT License\n")).toBe(true);
    const ci = text(ROOT, ".github", "workflows", "ci.yml");
    expect(ci).toContain("\n  pull_request:\n    branches: [main, dev]\n");
    expect(ci).toContain("\n  sandbox:\n    name: Sandbox integration tests\n");
    expect(ci).toContain("\n  reproducible:\n    name: Reproducible build and code hash");

    const ext = JSON.parse(text(ROOT, "apps", "extension", "package.json")) as { version: string };
    expect(ext.version).toBe("0.1.0");
    expect(store.body).toBe(
      "Version 0.1.0 queues invoices from your browser. It cannot pay or approve.",
    );
    expect(readmeRow("Browser extension for Chrome")).toContain(
      "**Shipped** on the Chrome Web Store as version 0.1.0",
    );
    expect(text(ROOT, "apps", "extension", "store", "listing.md")).toContain(
      "It can't pay or approve.",
    );
  });

  it("the also line: attestation checks that exist, and two mainnet payouts through NEAR Intents", () => {
    expect(BUILT_ON.also).toBe(
      "Also used: Intel TDX and NVIDIA NRAS attestation, which `verify --online` checks (O1 and O2). NEAR Intents payouts are built and tested against a testnet stand-in, and two have run on mainnet, tests to the owner's own Base address on 2026-11-13: 1.00 USDC decided by code rules alone, then 0.25 USDC decided by an attested model and the code rules.",
    );
    expect(prose).toContain(
      "`verify --online` loads the optional `@nearai/inference-sdk` to check the TDX quote (O1) and the GPU evidence (O2)",
    );
    expect(prose).toContain(
      "On testnet, `intents-stub.probarion.testnet` stands in for `intents.near`",
    );
    expect(prose).toContain(
      "On mainnet two payouts have run this way, both tests to the owner's own Base address on 2026-11-13. In S1 `v0.probarion.near` paid 1.00 USDC, a test decided by code rules alone",
    );
    expect(prose).toContain(
      "In S2 it paid 0.25 USDC, decided by an attested model and the code rules, and the bridge released 0.2476 USDC",
    );
  });
});

describe("the built-on copy", () => {
  const all = strings(BUILT_ON);

  it("is plain ASCII, with no em or en dash", () => {
    expect(all.length).toBeGreaterThan(30);
    for (const s of all) {
      expect(s, s).toMatch(/^[\x20-\x7e]*$/);
      expect(s, s).not.toMatch(DASHES);
    }
    expect(visibleText(section())).not.toMatch(DASHES);
  });

  it("keeps each caption to about 90 characters, and each sentence under the names to 125", () => {
    const captions = [
      ...BUILT_ON.rows.flatMap((r) => [
        r.label,
        r.name,
        r.domain,
        r.note,
        ...r.checks,
        ...r.links.map((l) => l.label),
      ]),
      ...BUILT_ON.ships.flatMap((c) => [c.name, c.tag, c.body, c.link.label]),
      BUILT_ON.title,
      BUILT_ON.shipsTitle,
    ];
    // As a visitor reads them: a backtick is markup for code, not a character on the page.
    for (const c of captions) expect(c.replace(/`/g, "").length, c).toBeLessThanOrEqual(90);
    for (const s of [BUILT_ON.sub, ...BUILT_ON.rows.map((r) => r.body)]) {
      expect(s.length, s).toBeLessThanOrEqual(125);
    }
  });

  it("claims no partnership, backing or endorsement, and says twice that none is implied", () => {
    expect(BUILT_ON.sub).toContain("No partnership or endorsement is implied.");
    expect(BUILT_ON.trademark).toContain("not to imply an endorsement");
    for (const s of all) expect(withoutDisclaimers(s), s).not.toMatch(CLAIM_WORDS);
    const out = visibleText(section());
    expect(withoutDisclaimers(out)).not.toMatch(CLAIM_WORDS);
    expect(withoutDisclaimers(out)).not.toMatch(/endorse/i);
  });

  it("gives every trademark notice, for every mark the section names", () => {
    for (const notice of [
      "NEAR, NEAR Intents, NEAR AI Cloud, USDC, Base and Solana are trademarks of their respective owners.",
      "npm is a registered trademark of npm, Inc.",
      "Model Context Protocol and MCP are trademarks of LF Projects, LLC.",
      "GitHub and the Invertocat logo are trademarks of GitHub, Inc.",
      // The extension card links its Chrome Web Store listing by name, so the store's name has its notice too.
      "Chrome and Chrome Web Store are trademarks of Google LLC.",
      "Intel is a trademark of Intel Corporation or its subsidiaries.",
      "NVIDIA is a trademark of NVIDIA Corporation.",
    ]) {
      expect(BUILT_ON.trademark).toContain(notice);
    }
    // It says Probarion is designed to pay through Base and Solana: two Base payouts and no Solana payout have run on mainnet.
    expect(BUILT_ON.trademark).toContain("built on or is designed to pay through");
  });

  it("matches the README's License line, which says the same in its first two sentences", () => {
    const [first, second] = BUILT_ON.trademark.split(/(?<=\.)\s+/);
    expect(first).toBe(
      "NEAR, NEAR Intents, NEAR AI Cloud, USDC, Base and Solana are trademarks of their respective owners.",
    );
    const license = README.slice(README.indexOf("## License") + "## License".length).trim();
    expect(license.replace(/\s+/g, " ")).toBe(`[MIT](LICENSE). ${first} ${second}`);
    expect(license).not.toContain("pays through");
  });
});

describe("the built-on marks", () => {
  it("draws NEAR's logo from NEAR's own file: its viewBox and its five paths, unchanged and unfilled", () => {
    const svg = renderToStaticMarkup(createElement(NearLogo));
    expect(svg).toMatch(
      /^<svg viewBox="0 0 1440 351" role="img" aria-label="NEAR Protocol" focusable="false">/,
    );
    const paths = [...svg.matchAll(/<path d="([^"]+)"(?:\/>|><\/path>)/g)].map((m) => m[1]);
    expect(paths).toHaveLength(5);
    // sha256 of the five `d` values of logo_nomargin.svg (NEAR_Logos.zip), joined by "\n", in the file's order.
    expect(createHash("sha256").update(paths.join("\n")).digest("hex")).toBe(
      "d821205e3018b129dc1448a57061de36524fa2689a056fa8496b2deca78a1736",
    );
    // No recolour, opacity, stretch or transform: the logo is the file's black at its own aspect ratio.
    expect(svg).not.toMatch(/\s(fill|stroke|opacity|transform|style|preserveAspectRatio)=/);
    const css = text(WEB, "src", "components", "site", "site.module.css");
    const rule = css.slice(
      css.indexOf(".nearLogo {"),
      css.indexOf("}", css.indexOf(".nearLogo {")),
    );
    expect(rule).toContain("aspect-ratio: 1440 / 351");
    expect(rule).toContain("height: auto");
    expect(rule).not.toMatch(/fill|opacity|filter|transform/);
  });

  it("draws the npm, MCP and GitHub logos from their owners' files: viewBox and paths unchanged, colours their own", () => {
    const logos = [
      // sha256 of the `d` values, joined by "\n" in the file's order: npm's black wordmark (github.com/npm/logos),
      // the MCP light-theme logo (modelcontextprotocol.io), and Primer Octicons' mark-github-24.svg.
      {
        svg: renderToStaticMarkup(createElement(NpmLogo)),
        viewBox: "0 0 780 250",
        paths: 1,
        sha256: "ede0dd516b28952fdf2f6ea7fce98ade900c9a45dab86191ac134b6ffb0bc54e",
        colours: ['fill="#231F20"'],
      },
      {
        svg: renderToStaticMarkup(createElement(McpLogo)),
        viewBox: "0 0 1338 195",
        paths: 4,
        sha256: "8d357b987943cd7a67cf0b3801f359c3885ab897ee1b45b4238c227d001289a3",
        colours: [
          'fill="none"',
          'stroke="black"',
          'stroke="black"',
          'stroke="black"',
          'fill="black"',
        ],
      },
      {
        svg: renderToStaticMarkup(createElement(GithubMark)),
        viewBox: "0 0 24 24",
        paths: 1,
        sha256: "fd34a5c2908d8dfb0c72c06ccb7de99c7085c2070d1c22682cd4073c960d9873",
        colours: [],
      },
    ];
    for (const logo of logos) {
      expect(logo.svg).toMatch(
        new RegExp(`^<svg viewBox="${logo.viewBox}" aria-hidden="true" focusable="false">`),
      );
      const paths = [...logo.svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
      expect(paths, logo.viewBox).toHaveLength(logo.paths);
      expect(createHash("sha256").update(paths.join("\n")).digest("hex"), logo.viewBox).toBe(
        logo.sha256,
      );
      expect(logo.svg.match(/\s(?:fill|stroke)="[^"]*"/g)?.map((m) => m.trim()) ?? []).toEqual(
        logo.colours,
      );
      expect(logo.svg, logo.viewBox).not.toMatch(
        /\s(opacity|transform|style|preserveAspectRatio)=/,
      );
    }
    // Each keeps its aspect ratio; only GitHub's, which sets no fill, takes the ink around it.
    const css = text(WEB, "src", "components", "site", "site.module.css");
    expect(rule(css, ".shipLogo svg")).toContain("width: auto;");
    expect(rule(css, ".shipLogo .npmLogo")).toContain("aspect-ratio: 780 / 250;");
    expect(rule(css, ".shipLogo .mcpLogo")).toContain("aspect-ratio: 1338 / 195;");
    expect(rule(css, ".shipLogo .githubMark")).toContain("fill: currentColor;");
    for (const sel of [".shipLogo", ".shipLogo svg", ".shipLogo .npmLogo", ".shipLogo .mcpLogo"])
      expect(rule(css, sel), sel).not.toMatch(/fill|opacity|filter|transform/);
  });

  it("names every mark in text too: one image, NEAR's, and every logo and glyph beside it hidden from screen readers", () => {
    const html = section();
    expect(html).not.toContain("<img");
    const svgs = [...html.matchAll(/<svg[^>]*>/g)].map((m) => m[0]);
    const images = svgs.filter((s) => s.includes('role="img"'));
    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/viewBox="0 0 1440 351" role="img" aria-label="NEAR Protocol"/);
    for (const s of svgs.filter((s) => !s.includes('role="img"')))
      expect(s, s).toContain('aria-hidden="true"');
    // Each card's logo row is hidden, and the card's heading names it.
    const logoRows = [
      ...html.matchAll(
        /<span class="[^"]*shipLogo[^"]*" aria-hidden="true"><svg(?: class="[^"]*")? viewBox="([^"]+)"/g,
      ),
    ];
    expect(logoRows.map((m) => m[1])).toEqual([
      "0 0 780 250",
      "0 0 1338 195",
      "0 0 24 24",
      "0 0 144 122",
    ]);
    // The extension card shows Probarion's own mark, with its own gradient id.
    expect(html).toContain('id="probarion-coin-built-on"');
    expect(html).toContain('fill="url(#probarion-coin-built-on)"');
    // No logo file under public/built-on but NEAR's, and no store badge anywhere in public/.
    const dir = join(WEB, "public", "built-on");
    const files = existsSync(dir) ? readdirSync(dir) : [];
    expect(files.filter((f) => !/^near-[a-z-]+\.svg$/.test(f))).toEqual([]);
    const walkNames = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walkNames(join(d, e.name)) : [e.name],
      );
    expect(
      walkNames(join(WEB, "public")).filter((f) => /badge|chrome|cws|npm|mcp|nearai/i.test(f)),
    ).toEqual([]);
  });

  it("keeps the logos and the check marks visible in a Windows contrast theme", () => {
    const css = text(WEB, "src", "components", "site", "site.module.css");
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/\.nearLogo {\s*fill: currentColor;\s*}/);
    expect(forced).toMatch(/\.boCheck {\s*stroke: currentColor;\s*}/);
    // npm and MCP keep their black on a white plate (the surface token is #ffffff); GitHub's mark already takes the
    // text colour.
    expect(forced).toMatch(
      /\.shipLogo \.npmLogo,\s*\.shipLogo \.mcpLogo {\s*forced-color-adjust: none;[^}]*background: var\(--color-surface\);\s*}/,
    );
    expect(text(WEB, "src", "app", "globals.css")).toContain("--color-surface: #ffffff;");
  });
});

describe("the built-on links and landmarks", () => {
  it("links only to pages, anchors and repository files that exist, and to https addresses elsewhere", () => {
    const links = hrefs(section());
    expect(links.length).toBe(11);
    for (const href of links) {
      if (href.startsWith("/")) expect(linkProblem(href, ""), href).toBeNull();
      else {
        expect(href.startsWith("https://"), href).toBe(true);
        expect(linkProblem(href, ""), href).toBeNull();
      }
    }
    // The proof page gives each decision card id="seq-N". Entries 13 and 15 are the decisions of the two payments
    // of 2026-11-12.
    for (const seq of [13, 15]) {
      expect(seqAnchorId(seq)).toBe(`seq-${seq}`);
      expect(links).toContain(`/proof/demo.vaults.probarion.testnet#${seqAnchorId(seq)}`);
      expect(text(ROOT, "docs", "evidence", "demo-vault", "README.md")).toContain(
        `[entry ${seq}](https://probarion.xyz/proof/demo.vaults.probarion.testnet#seq-${seq})`,
      );
    }
    // The docs anchor is the slug of the heading.
    expect(new GithubSlugger().slug("The mainnet vault")).toBe("the-mainnet-vault");
  });

  it("opens this site's pages in this tab and every other address in a new one, each named for where it goes", () => {
    const html = section();
    const names: string[] = [];
    for (const a of anchors(html)) {
      const href = /\shref="([^"]*)"/.exec(a)?.[1] ?? "";
      const name = visibleText(a.replace(/<span aria-hidden="true">[^<]*<\/span>/g, ""));
      expect(name.replace(" (opens in a new tab)", "").length, a).toBeGreaterThan(5);
      // A no-break space before the arrow: a link that wraps keeps its arrow on the line of its last word.
      if (href.startsWith("/")) {
        expect(a, href).not.toContain('target="_blank"');
        expect(a, href).toContain('\u00a0<span aria-hidden="true">→</span>');
      } else {
        expect(a, href).toContain('target="_blank"');
        expect(a, href).toContain('rel="noreferrer"');
        expect(name.endsWith("(opens in a new tab)"), href).toBe(true);
        expect(a, href).toContain('\u00a0<span aria-hidden="true">↗</span>');
      }
      names.push(name);
    }
    expect(new Set(names).size).toBe(names.length);
    // Every arrow is hidden from screen readers.
    expect(visibleText(html.replace(/<span aria-hidden="true">[^<]*<\/span>/g, ""))).not.toMatch(
      /[→↗]/,
    );
  });

  it("keeps list semantics where the stylesheet removes the bullets, and a heading for each row and card", () => {
    const html = section();
    const lists = [...html.matchAll(/<ul[^>]*>/g)].map((m) => m[0]);
    expect(lists).toHaveLength(6);
    for (const ul of lists) expect(ul, ul).toContain('role="list"');
    expect([...html.matchAll(/<h3[^>]*>/g)]).toHaveLength(3);
    expect([...html.matchAll(/<h4[^>]*>/g)]).toHaveLength(4);
    expect(html).toMatch(/<h3[^>]*><svg[^>]*aria-label="NEAR Protocol"/);
  });

  it("leaves no two elements of the landing page with the same id", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(BetaStripView, { network: "testnet" }),
        createElement(SiteHeader),
        createElement(Home),
        createElement(SiteFooter),
      ),
    );
    const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(ids).toEqual(
      expect.arrayContaining(["probarion-coin", "probarion-coin-built-on", "built-on"]),
    );
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it("stacks on a phone: the three columns, the evidence under the checks, and the notices to the left", () => {
    const css = text(WEB, "src", "components", "site", "site.module.css");
    // Below 1101px the evidence column would be too narrow for its links: they move under the checks.
    const narrow = mediaBlocks(css, "(max-width: 1100px)");
    expect(narrow).toMatch(/\.boRow {\s*grid-template-columns: minmax\(0, 2fr\) minmax\(0, 3fr\);/);
    expect(narrow).toMatch(/\.boLinks {\s*grid-column: 2;/);
    // Above it, the evidence column keeps room for its longest link on one line, the same in both rows.
    expect(rule(css, ".boRow")).toContain(
      "grid-template-columns: minmax(0, 4fr) minmax(0, 6fr) minmax(232px, 3fr);",
    );
    const longest = Math.max(...BUILT_ON.rows.flatMap((r) => r.links.map((l) => l.label.length)));
    // 13px mono is about 7.8px a character: the label, a space and the arrow fit in 232px up to 27 characters.
    expect(longest).toBeLessThanOrEqual(27);
    // The four cards: one row on a desktop, two by two below 1101px, one column on a phone.
    expect(rule(css, ".ships")).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
    expect(narrow).toMatch(/\.ships {\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(mediaBlocks(css, "(max-width: 960px)")).not.toMatch(/\.ships\b/);
    const phone = mediaBlocks(css, "(max-width: 620px)");
    expect(phone).toMatch(/\.ships {\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(phone).toMatch(/\.boRow {\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(phone).toMatch(/\.boLinks {\s*grid-column: auto;/);
    expect(phone).toMatch(/\.boFine {\s*margin-left: 0;\s*text-align: left;/);
    // The phone rules come after the narrow ones, so that they win at 620px and below.
    expect(css.indexOf("@media (max-width: 620px)")).toBeGreaterThan(
      css.lastIndexOf("@media (max-width: 1100px)"),
    );
  });

  it("sets the sentence beside the heading on its last line, at the right, from 961px, and under it below", () => {
    expect(section()).toMatch(/<div class="[^"]*sectionHead[^"]* [^"]*boHead[^"]*"><h2/);
    const css = text(WEB, "src", "components", "site", "site.module.css");
    // Every section head wraps; this one's heading and sentence are too wide for one line on a desktop.
    expect(css).toMatch(/\.sectionHead {[^}]*flex-wrap: wrap;[^}]*align-items: flex-end;/);
    const desktop = mediaBlocks(css, "(min-width: 961px)");
    expect(desktop).toMatch(/\.boHead {\s*flex-wrap: nowrap;\s*align-items: baseline;\s*}/);
    expect(desktop).toMatch(
      /\.boHead > p {\s*max-width: 44em;\s*font-size: 15px;\s*text-align: right;\s*text-wrap: balance;\s*}/,
    );
    // Nothing sets it outside that block, so at 960px and below the head wraps like every other.
    expect(css.slice(0, css.indexOf("@media"))).not.toMatch(/\.boHead\b/);
  });

  it("sets each card's tag under its name, lets its link wrap, and sets the small label in the gold for small text", () => {
    const css = text(WEB, "src", "components", "site", "site.module.css");
    // On a narrow card of the four, a tag beside the name would fall onto a line of its own.
    expect(rule(css, ".shipHead")).toMatch(/flex-direction: column;\s*align-items: flex-start;/);
    expect(rule(css, ".shipTag")).toContain("font-size: 12px;");
    // "probarion/probarion on GitHub" is wider than a narrow card: the link wraps, and its arrow stays on its last line.
    expect(rule(css, ".shipGo")).not.toContain("nowrap");
    // gold-ink reads at 7:1 or more on the white card (globals.css); gold-small is kept for marks like the checks.
    expect(rule(css, ".boLabel")).toContain("color: var(--color-gold-ink);");
    expect(rule(css, ".boCheck")).toContain("stroke: var(--color-gold-small);");
  });
});

describe("the README beside the built-on section", () => {
  it("links the MCP registry listing from the 0.1.1 release row, and names the section where it lists the landing's parts", () => {
    expect(readmeRow("npm release 0.1.1")).toContain(`(${LINKS.mcpRegistry})`);
    expect(readmeRow("Web console")).toContain(`"${BUILT_ON.title}"`);
  });
});
