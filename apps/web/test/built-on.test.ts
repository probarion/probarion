// What Probarion rests on (components/site/BuiltOn.tsx Foundations, #built-on in #verify) and where to get it
// (GetProbarion, #get-probarion in the closing, with the trademark lead): text rows and text links, no logos. Every
// token, name and version is held to the file it comes from, and every link is checked offline (npmjs.com answers a
// script with a bot check, so nothing here fetches).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import { BetaStripView } from "@/components/site/BetaStrip";
import { Foundations, GetProbarion, TrademarkLead } from "@/components/site/BuiltOn";
import hd from "@/components/site/head.module.css";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import sh from "@/components/site/ships.module.css";
import sm from "@/components/site/site.module.css";
import { CLI_ON_NPM } from "@/lib/proof/cli";
import {
  BUILT_ON,
  CLOSING,
  LINKS,
  STACK,
  type StackRow,
  TAMPER_COPY,
  VERIFY_LINES,
  VERIFY_NOTE,
} from "@/lib/site/facts";
import { NEXT_STEP } from "@/lib/site/next-step";
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

const ROWS: readonly StackRow[] = STACK.rows;
const foundations = () => renderToStaticMarkup(createElement(Foundations));
const getProbarion = () => renderToStaticMarkup(createElement(GetProbarion));
const landing = () => renderToStaticMarkup(createElement(Home));
/** The closing, from its section to the end of the page. */
const closing = (html: string) => html.slice(html.indexOf(`<section class="${sm.close}"`));
const SHIPS_CSS = text(WEB, "src", "components", "site", "ships.module.css");

/** The text a visitor reads: inline tags join their words, block tags part them. */
const visibleText = (html: string) =>
  html
    .replace(/<\/?(?:a|code|span|wbr)\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const anchors = (html: string) => [...html.matchAll(/<a\s[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
const hrefOf = (a: string) => /\shref="([^"]*)"/.exec(a)?.[1] ?? "";
/** A link's accessible name: its words without the arrow, which is hidden from screen readers. */
const nameOf = (a: string) =>
  visibleText(a.replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, ""));
/** A rule at the top level of a stylesheet, outside any @media block. */
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};
/** How tall a link's box is: its padding above and below and one line of its text. */
const targetHeight = (block: string, size: number, lineHeight: number) =>
  2 * Number(/padding-block: (\d+)px;/.exec(block)?.[1]) + size * lineHeight;

/** An en dash or an em dash (by code point, so that this file holds neither). */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
/** The words that would claim a relationship Probarion does not have. */
const CLAIM_WORDS =
  /\bpartner(s|ed|ship)?\b|\bbacked by\b|\btrusted by\b|\bsponsored by\b|\bendorsed by\b|\bpowered by\b|\bofficial partner\b/i;
/** The two places that may name a partnership or an endorsement: to say there is none. */
const DISCLAIMERS = [/No partnership or endorsement is implied\./g, /not to imply an endorsement/g];
const withoutDisclaimers = (s: string) => DISCLAIMERS.reduce((t, re) => t.replace(re, ""), s);

describe("what it rests on (#built-on)", () => {
  it("sits in #verify after the ledger test and before what works today, once, as a block with its own head", () => {
    const html = landing();
    const at = html.indexOf(`id="${STACK.id}"`);
    expect(html.split(`id="${STACK.id}"`)).toHaveLength(2);
    expect(at).toBeGreaterThan(html.indexOf(`<section class="${hd.section}" id="verify"`));
    expect(at).toBeGreaterThan(html.indexOf(TAMPER_COPY.checksFold));
    expect(at).toBeLessThan(html.indexOf('id="status"'));
    expect(STACK.id).toBe(BUILT_ON.id);
    expect(html).toContain(
      `<div class="${hd.block}" id="${STACK.id}" role="group" aria-labelledby="${STACK.id}-title">` +
        `<header class="${hd.subHead}"><hgroup><p class="${sm.eyebrow}">${STACK.eyebrow}</p>` +
        `<h3 class="${hd.subTitle}" id="${STACK.id}-title">${STACK.title}</h3></hgroup>` +
        `<p class="${hd.lede} ${hd.subLede}">${STACK.lede}</p></header>`,
    );
  });

  it("draws four rows in order, each its label and name, its sentences, then its tokens in mono", () => {
    expect(ROWS.map((r) => [r.id, r.label, r.name])).toEqual([
      ["contract", "On NEAR", "Contract"],
      ["ledger", "Signed, anchored", "Ledger"],
      ["model", "Optional, attested", "Model"],
      ["route", "Cross-chain", "Payout route"],
    ]);
    // The lede counts the rows.
    expect(STACK.lede.startsWith("Four parts.")).toBe(true);
    const html = foundations();
    const rows = [
      ...html.matchAll(
        /<li class="[^"]*" data-row="([a-z]+)">([\s\S]*?)<\/li><\/ul><\/div><\/li>/g,
      ),
    ];
    expect(rows.map((m) => m[1])).toEqual(ROWS.map((r) => r.id));
    for (const [i, r] of ROWS.entries()) {
      const li = rows[i]?.[2] ?? "";
      expect(li, r.id).toContain(
        `<hgroup class="${sh.restHead}"><p class="${sh.restLabel}">${r.label}</p><h4 class="${sh.restTitle}">${r.name}</h4></hgroup>`,
      );
      expect(visibleText(li), r.id).toContain(r.body.replace(/`/g, ""));
      // The row ends in its tokens, each a code element, with what it names after it.
      const tokens = li.slice(li.indexOf(`<div class="${sh.tokens}">`));
      expect(tokens, r.id).not.toBe("");
      const codes = [...tokens.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => m[1]);
      expect(codes, r.id).toEqual(r.tokens.map((t) => t.code));
      for (const t of r.tokens) {
        if (t.note !== undefined)
          expect(visibleText(tokens), t.code).toContain(`${t.code}, ${t.note}`);
      }
    }
    expect(ROWS.every((r) => r.tokens.length > 0)).toBe(true);
  });

  it("ends the ledger row in the offline check the rest of the site gives, then the live run", () => {
    const ledger = ROWS.find((r) => r.id === "ledger");
    expect(ledger?.tokens.map((t) => t.code)).toEqual([...VERIFY_LINES, "verify --vault"]);
    expect(ledger?.tokensNote).toBe(CLI_ON_NPM ? VERIFY_NOTE : undefined);
    const html = foundations();
    if (CLI_ON_NPM) {
      expect(html.indexOf(VERIFY_NOTE)).toBeGreaterThan(0);
      expect(html.indexOf(VERIFY_NOTE)).toBeLessThan(
        html.indexOf(`<code>${VERIFY_LINES[0]}</code>`),
      );
    }
  });

  it("holds each token and claim to the code or the record it names", () => {
    const constants = text(ROOT, "packages", "core", "src", "constants.ts");
    const codes = ROWS.flatMap((r) => r.tokens.map((t) => t.code));
    // The mainnet vault, the testnet factory and NEAR Intents on mainnet.
    expect(codes).toContain("v0.probarion.near");
    expect(README).toContain("`v0.probarion.near`");
    expect(codes).toContain("vaults.probarion.testnet");
    expect(constants).toContain('factory: "vaults.probarion.testnet",');
    expect(codes).toContain("intents.near");
    expect(constants).toContain('intents: "intents.near",');
    // The flags are the CLI's own.
    const verify = text(ROOT, "packages", "cli", "src", "commands", "verify.ts");
    for (const flag of ["--offline", "--vault", "--online"]) expect(verify, flag).toContain(flag);
    // The model: the TEE evidence of 2026-11-13, and the limit its record states.
    const model = ROWS.find((r) => r.id === "model")?.body ?? "";
    const s2 = text(ROOT, "docs", "evidence", "mainnet-v0", "s2-2026-11-13", "README.md");
    expect(model).toContain("checked against Intel TDX and NVIDIA NRAS on 2026-11-13");
    expect(s2).toContain("TDX quotes");
    expect(s2).toContain("NVIDIA NRAS (O2)");
    expect(s2).toContain("The measurement is not pinned");
    expect(model).toContain("The TEE image is not pinned");
    // The payout route: the vault builds the memo itself.
    expect(ROWS.find((r) => r.id === "route")?.body).toContain("`WITHDRAW_TO:`");
    expect(text(ROOT, "contracts", "vault", "src", "lib.rs")).toContain(
      'pub const WITHDRAW_MEMO_PREFIX: &str = "WITHDRAW_TO:";',
    );
  });

  it("links the contract on testnet and how the parts fit, in this tab, to headings that exist", () => {
    const html = foundations();
    const links = anchors(html);
    expect(links.map(hrefOf)).toEqual([
      "/docs/start/how-one-payment-works#see-it-on-testnet",
      STACK.architecture.href,
    ]);
    expect(ROWS.find((r) => r.id === "contract")?.link?.href).toBe(links.map(hrefOf)[0]);
    for (const a of links) {
      const href = hrefOf(a);
      expect(linkProblem(href, ""), href).toBeNull();
      expect(a, href).not.toContain('target="_blank"');
      // A no-break space before the arrow: a link that wraps keeps its arrow on the line of its last word.
      expect(a, href).toContain(' <span aria-hidden="true">→</span>');
    }
    expect(nameOf(links[1] ?? "")).toBe(STACK.architecture.label);
    // The foot says that no endorsement is implied, then links the architecture.
    const foot = html.slice(html.indexOf(`<p class="${sh.restFoot}">`));
    expect(visibleText(foot)).toBe(`${STACK.noEndorsement} ${STACK.architecture.label} →`);
  });

  it("draws no logo and no image, and nests its headings under #verify's h2: h3, then a row's h4", () => {
    const html = foundations();
    expect(html).not.toMatch(/<(?:svg|img)\b/);
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels).toEqual([3, ...ROWS.map(() => 4)]);
    for (const ul of html.match(/<ul[^>]*>/g) ?? []) expect(ul).toContain('role="list"');
  });

  it("stacks a row's tokens under its sentences from 1100px down, and everything in one column on a phone", () => {
    expect(rule(SHIPS_CSS, ".rest")).toContain(
      "grid-template-columns: 180px minmax(0, 1fr) minmax(0, 380px);",
    );
    const at = (q: string) => SHIPS_CSS.slice(SHIPS_CSS.indexOf(`@media (max-width: ${q})`));
    expect(at("1100px")).toMatch(/\.rest {\s*grid-template-columns: 160px minmax\(0, 1fr\);/);
    expect(at("1100px")).toMatch(/\.tokens {\s*grid-column: 2;/);
    expect(at("640px")).toMatch(/\.rest {\s*grid-template-columns: minmax\(0, 1fr\);/);
    // A long command breaks inside its chip rather than run past a 320px column.
    expect(rule(SHIPS_CSS, ".token code")).toContain("overflow-wrap: anywhere;");
    expect(rule(SHIPS_CSS, ".token code")).toContain("font-size: 13.5px;");
    // The foot's link is a 44px touch target.
    expect(targetHeight(rule(SHIPS_CSS, ".restFoot a"), 15, 1.5)).toBeGreaterThanOrEqual(44);
  });
});

describe("where to get Probarion (#get-probarion)", () => {
  it("is a row of the closing, after the quiet links and before the trademark lead and the way into the console", () => {
    const close = closing(landing());
    const at = close.indexOf(`id="${BUILT_ON.shipsId}"`);
    expect(at).toBeGreaterThan(
      close.indexOf(`href="${CLOSING.quiet[CLOSING.quiet.length - 1]?.href}"`),
    );
    expect(at).toBeLessThan(close.indexOf(BUILT_ON.trademark.lead.slice(0, 40)));
    expect(at).toBeLessThan(close.indexOf(`href="${NEXT_STEP.closing.route}"`));
    // Its id is on the visible row, which its heading names.
    expect(close).toContain(
      `<div class="${sh.get}" id="${BUILT_ON.shipsId}" role="group" aria-labelledby="${BUILT_ON.shipsId}-title">` +
        `<h3 class="${sh.getTitle}" id="${BUILT_ON.shipsId}-title">${BUILT_ON.shipsTitle}</h3>`,
    );
  });

  it("links each place by its name, in a new tab with the arrow, then says what is there", () => {
    expect(BUILT_ON.ships.map((s) => [s.name, s.short])).toEqual([
      ["npm public registry", "4 packages, 0.1.1"],
      ["Official MCP Registry", "`io.github.probarion/probarion`"],
      ["GitHub", "MIT"],
      ["Chrome Web Store", "Probarion 0.1.0"],
    ]);
    const html = getProbarion();
    const items = [...html.matchAll(/<li class="[^"]*" data-ship="([a-z-]+)">([\s\S]*?)<\/li>/g)];
    expect(items.map((m) => m[1])).toEqual(BUILT_ON.ships.map((s) => s.id));
    for (const [i, ship] of BUILT_ON.ships.entries()) {
      const li = items[i]?.[2] ?? "";
      const [link, ...more] = anchors(li);
      expect(more, ship.id).toEqual([]);
      expect(hrefOf(link ?? ""), ship.id).toBe(ship.link.href);
      expect(link, ship.id).toContain('target="_blank"');
      expect(nameOf(link ?? ""), ship.id).toBe(`${ship.name} (opens in a new tab)`);
      expect(link, ship.id).toContain('aria-hidden="true">↗</span>');
      // What is there is outside the link, after it.
      const detail = li.slice(li.indexOf("</a>"));
      expect(visibleText(detail), ship.id).toBe(`: ${ship.short.replace(/`/g, "")}`);
      expect(linkProblem(ship.link.href, ""), ship.id).toBeNull();
    }
    expect(html).not.toMatch(/<(?:svg|img)\b/);
    for (const ul of html.match(/<ul[^>]*>/g) ?? []) expect(ul).toContain('role="list"');
  });

  it("holds every name and version to the packages, server.json, the license and the extension", () => {
    const [npm, mcp, github, store] = BUILT_ON.ships;
    const pkgs = ["cli", "sdk", "mcp", "core"].map(
      (dir) =>
        JSON.parse(text(ROOT, "packages", dir, "package.json")) as {
          name: string;
          version: string;
        },
    );
    expect(pkgs.map((p) => p.name)).toEqual([
      "probarion",
      "@probarion/sdk",
      "@probarion/mcp",
      "@probarion/core",
    ]);
    expect(npm.ids).toEqual(pkgs.map((p) => `\`${p.name}\``));
    for (const pkg of pkgs) expect(pkg.version, pkg.name).toBe("0.1.1");
    expect(npm.short).toBe(`${pkgs.length} packages, ${pkgs[0]?.version}`);
    const server = JSON.parse(text(ROOT, "packages", "mcp", "server.json")) as { name: string };
    expect(mcp.short).toBe(`\`${server.name}\``);
    expect(new URL(LINKS.mcpRegistry).searchParams.get("q")).toBe(server.name);
    expect(text(ROOT, "LICENSE").startsWith(`${github.short} License\n`)).toBe(true);
    const ext = JSON.parse(text(ROOT, "apps", "extension", "package.json")) as { version: string };
    const listing = text(ROOT, "apps", "extension", "store", "listing.md");
    expect(store.short).toBe(`${store.ids[0]} ${ext.version}`);
    expect(listing).toContain(`**Name:** ${store.ids[0]}\n`);
    expect(readmeRow("Browser extension for Chrome")).toContain(
      `**Shipped** on the Chrome Web Store as version ${ext.version}`,
    );
    // The README's release row links the registry listing the row links.
    expect(readmeRow("npm release 0.1.1")).toContain(`(${LINKS.mcpRegistry})`);
  });

  it("makes each link a 44px touch target, the quiet links of the closing too", () => {
    expect(targetHeight(rule(SHIPS_CSS, ".getLink"), 16, 1.5)).toBeGreaterThanOrEqual(44);
    expect(targetHeight(rule(SHIPS_CSS, ".quietLink"), 15, 1.5)).toBeGreaterThanOrEqual(44);
    for (const sel of [".getLink", ".quietLink"])
      expect(rule(SHIPS_CSS, sel), sel).toContain("display: inline-block;");
  });
});

describe("the trademark lead", () => {
  it("is the README's License line, said once, in the closing's small print", () => {
    const lead = BUILT_ON.trademark.lead;
    const [first, second, ...rest] = lead.split(/(?<=\.)\s+/);
    expect(rest).toEqual([]);
    expect(first).toBe(
      "NEAR, NEAR Intents, NEAR AI Cloud, USDC, Base and Solana are trademarks of their respective owners.",
    );
    const license = README.slice(README.indexOf("## License") + "## License".length).trim();
    expect(license.replace(/\s+/g, " ")).toBe(`[MIT](LICENSE). ${first} ${second}`);
    // It says Probarion is designed to pay through Base and Solana: two Base payouts and no Solana payout have run.
    expect(lead).toContain("built on or is designed to pay through");
    expect(renderToStaticMarkup(createElement(TrademarkLead))).toBe(
      `<p class="${sh.legal}">${lead}</p>`,
    );
    const html = landing();
    expect(html.split(lead)).toHaveLength(2);
    expect(closing(html)).toContain(lead);
  });

  it("claims no partnership, backing or endorsement, and says that none is implied", () => {
    expect(STACK.noEndorsement).toBe("No partnership or endorsement is implied.");
    expect(BUILT_ON.trademark.lead).toContain("not to imply an endorsement");
    const out = [foundations(), getProbarion(), renderToStaticMarkup(createElement(TrademarkLead))]
      .map(visibleText)
      .join(" ");
    expect(withoutDisclaimers(out)).not.toMatch(CLAIM_WORDS);
    expect(withoutDisclaimers(out)).not.toMatch(/endorse/i);
  });
});

describe("the copy of what it rests on and where to get it", () => {
  const all = [
    ...strings(STACK),
    ...BUILT_ON.ships.flatMap((s) => [s.name, s.short]),
    BUILT_ON.shipsTitle,
    BUILT_ON.trademark.lead,
  ];

  it("has no em or en dash, and makes no first, only or guaranteed claim", () => {
    for (const s of all) {
      expect(s, s).not.toMatch(DASHES);
      expect(s, s).not.toMatch(/\b(first|only|never|unhackable|unbreakable|guaranteed)\b/i);
      expect(withoutDisclaimers(s), s).not.toMatch(CLAIM_WORDS);
    }
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
      expect.arrayContaining([
        "probarion-coin",
        STACK.id,
        BUILT_ON.shipsId,
        "status",
        "known-gaps",
      ]),
    );
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});
