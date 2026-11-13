// The landing's shared section head and its one rhythm. Every section from the problem to Built on opens the same
// way, through SectionHead.tsx: a hairline, the eyebrow, the heading and the lede, stacked on one left edge. Each
// owns G (--space-section) of paper below itself and none above, so the gap between any two sections is G.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import h from "@/components/site/head.module.css";
import s from "@/components/site/site.module.css";
import {
  BUILT_ON,
  CHAIN,
  COMPARE,
  CONSOLE_SHOTS,
  HEADER_ANCHORS,
  INTEGRATE,
  JOURNEY,
  LIVE_CHECK,
  PROBLEM,
  STATUS,
  STATUS_BOARD,
  TAMPER_COPY,
} from "@/lib/site/facts";
import { PAYOUTS } from "@/lib/site/mainnet-payout-data";
import { sectionHead } from "@/lib/site/mainnet-payout-section";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(WEB, ...parts), "utf8");

const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const text = (html: string) =>
  decode(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
const plain = (copy: string) => copy.replace(/`/g, "");

const MAINNET_HEAD = sectionHead(PAYOUTS);

/** The landing's sections, in page order, with the copy their heads read. */
const SECTIONS = [
  { id: "problem", eyebrow: PROBLEM.eyebrow, title: PROBLEM.title, lede: PROBLEM.sub },
  { id: "try", eyebrow: LIVE_CHECK.eyebrow, title: LIVE_CHECK.title, lede: LIVE_CHECK.intro },
  {
    id: "mainnet",
    eyebrow: MAINNET_HEAD.eyebrow,
    title: `${MAINNET_HEAD.line1} ${MAINNET_HEAD.line2}`,
    lede: MAINNET_HEAD.lede,
  },
  { id: "compare", eyebrow: COMPARE.eyebrow, title: COMPARE.title, lede: COMPARE.sub },
  { id: "payment", eyebrow: JOURNEY.eyebrow, title: JOURNEY.title, lede: JOURNEY.intro },
  { id: "integrate", eyebrow: INTEGRATE.eyebrow, title: INTEGRATE.title, lede: INTEGRATE.sub },
  {
    id: "console",
    eyebrow: CONSOLE_SHOTS.eyebrow,
    title: CONSOLE_SHOTS.title,
    lede: CONSOLE_SHOTS.intro,
  },
  { id: "verify", eyebrow: TAMPER_COPY.eyebrow, title: TAMPER_COPY.title, lede: TAMPER_COPY.intro },
  { id: "chain", eyebrow: CHAIN.eyebrow, title: CHAIN.title, lede: CHAIN.intro },
  { id: "status", eyebrow: STATUS_BOARD.eyebrow, title: STATUS.title, lede: STATUS_BOARD.lede },
  { id: BUILT_ON.id, eyebrow: BUILT_ON.eyebrow, title: BUILT_ON.title, lede: BUILT_ON.sub },
] as const;

const html = renderToStaticMarkup(createElement(Home));
const start = (id: string) => html.indexOf(`<section class="${h.section}" id="${id}"`);
/** The closing's <section>, where the last section's part ends. */
const closing = html.lastIndexOf("<section", html.indexOf(`class="${s.close}"`));

describe("the landing's section heads", () => {
  it("open every section from the problem to Built on with a hairline, the eyebrow, the heading and the lede", () => {
    for (const x of SECTIONS) {
      const head = new RegExp(
        `<section class="${h.section}" id="${x.id}" aria-labelledby="${x.id}-title"><div class="${s.wrap}(?: [^"]+)?">` +
          `<header class="${h.head}"><hgroup><p class="${s.eyebrow}">([^<]+)</p>` +
          // The mainnet heading's two lines are spans of their own.
          `<h2 class="${s.h2} ${h.title}" id="${x.id}-title">([\\s\\S]*?)</h2></hgroup>` +
          `<p class="${h.lede}">([\\s\\S]*?)</p>(<dl class="[^"]+">[\\s\\S]*?</dl>)?</header>`,
      ).exec(html);
      expect(head, x.id).not.toBeNull();
      expect(decode(head?.[1] ?? ""), x.id).toBe(x.eyebrow);
      expect(text(head?.[2] ?? ""), x.id).toBe(x.title);
      expect(text(head?.[3] ?? ""), x.id).toBe(plain(x.lede));
      // Only the console and the chain say one thing for their whole body under the lede: the record their three
      // shots or transactions share.
      expect(head?.[4] !== undefined, x.id).toBe(x.id === "console" || x.id === "chain");
    }
  });

  it("keeps the page order and every anchor the nav, the hero and other pages link to", () => {
    const at = SECTIONS.map((x) => start(x.id));
    for (const [i, x] of SECTIONS.entries()) expect(at[i], x.id).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The mainnet payouts sit under the live check, the ink band between the integration and the console
    // screenshots, and the closing follows Built on.
    expect(start("mainnet")).toBeGreaterThan(start("try"));
    expect(start("mainnet")).toBeLessThan(start("compare"));
    expect(html.indexOf('id="payee"')).toBeGreaterThan(start("integrate"));
    expect(html.indexOf('id="payee"')).toBeLessThan(start("console"));
    expect(closing).toBeGreaterThan(start(BUILT_ON.id));
    // The comparison table is still named by its heading.
    expect(html).toContain('<table class="');
    expect(html).toMatch(/<table[^>]*aria-labelledby="compare-title"/);
  });

  it("leaves none of the old head or spacing classes, and one head per section", () => {
    // No section uses them any more, so they are gone from the stylesheet.
    const css = read("src", "components", "site", "site.module.css");
    for (const old of [/\.section\b/, /\.flush\b/, /\.sectionHead\b/, /\.shots\b/, /\.boHead\b/])
      expect(css).not.toMatch(old);
    for (const [i, x] of SECTIONS.entries()) {
      const next = SECTIONS[i + 1];
      // Built on's part ends where the closing's <section> opens.
      const part = html.slice(start(x.id), next ? start(next.id) : closing);
      expect(part.length, x.id).toBeGreaterThan(0);
      // One head per section: the eyebrow and the heading are not repeated in its body.
      expect(part.split(`class="${h.head}"`).length - 1, x.id).toBe(1);
    }
  });

  it("gives every section an eyebrow: the four kept word for word, and four new ones that add no claim", () => {
    expect(PROBLEM.eyebrow).toBe("The problem");
    expect(LIVE_CHECK.eyebrow).toBe("Try it, live on NEAR testnet");
    expect(COMPARE.eyebrow).toBe("Why not just a spending limit?");
    expect(INTEGRATE.eyebrow).toBe("Plug in your agent");
    expect(JOURNEY.eyebrow).toBe("How a payment works");
    expect(CONSOLE_SHOTS.eyebrow).toBe("The console");
    expect(TAMPER_COPY.eyebrow).toBe("Verify a test ledger");
    expect(CHAIN.eyebrow).toBe("Read it on chain");
    expect(BUILT_ON.eyebrow).toBe("The stack");
    // The journey's eyebrow is the nav link's label for the same anchor.
    expect(HEADER_ANCHORS.find((a) => a.href === "/#payment")?.label).toBe(JOURNEY.eyebrow);
    // The verifier runs on a test fixture, and its lede says so too.
    expect(TAMPER_COPY.intro).toContain("test fixture");
  });

  it("names in the console's heading what its screenshots show: a spend held for an approver, then paid", () => {
    expect(CONSOLE_SHOTS.title).toBe("An invoice held for an approver, then paid.");
    const ids = CONSOLE_SHOTS.shots.map((x) => x.id);
    expect(ids).toEqual(["held", "invoice", "paid"]);
    expect(CONSOLE_SHOTS.shots[0]?.title).toBe("Held for an approver");
    expect(CONSOLE_SHOTS.shots[2]?.title).toBe("Paid after approval");
  });

  it("counts in the chain's heading as many transactions as it lists, and says testnet in the record and on each hash", () => {
    const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    const first = (CHAIN.title.split(" ")[0] ?? "").toLowerCase();
    expect(WORDS).toContain(first);
    expect(WORDS.indexOf(first)).toBe(CHAIN.rows.length);
    // The heading names the network and the run as Known gaps does; the record and every hash's label say testnet too.
    expect(CHAIN.title).toBe("Three testnet transactions from the smoke run.");
    expect(CHAIN.network).toBe("Testnet");
    expect(CHAIN.evidenceLabel).toBe("Testnet transaction");
    expect(CHAIN.intro).toContain("with test tokens");
    expect(CHAIN.intro).toContain("testnet.nearblocks.io");
    for (const row of CHAIN.rows) expect(row.tx.url).toContain("testnet");
  });
});

describe("the landing's one rhythm", () => {
  const globals = read("src", "app", "globals.css");
  const head = read("src", "components", "site", "head.module.css");
  const site = read("src", "components", "site", "site.module.css");
  const hero = read("src", "components", "site", "hero.module.css");
  const rule = (css: string, selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("defines G once, in globals.css, at the value .section had", () => {
    const defs = [...globals.matchAll(/--space-section:\s*([^;]+);/g)].map((m) => m[1]);
    expect(defs).toEqual(["clamp(64px, 9vw, 128px)"]);
    expect(head).not.toMatch(/--space-section:/);
    expect(site).not.toMatch(/--space-section:/);
  });

  it("puts G below each section, the hero and the ink band, and none above a section", () => {
    expect(rule(head, ".section")).toContain("padding-block: 0 var(--space-section);");
    expect(rule(hero, ".hero")).toMatch(/padding-block: [^;]+ var\(--space-section\);/);
    expect(rule(site, ".band")).toContain("margin-bottom: var(--space-section);");
    // The closing's rule sits halfway down its gap, on the wrap's left edge like every head's hairline.
    expect(rule(site, ".close")).toContain("padding-block: 0 var(--space-section);");
    expect(rule(site, ".close")).not.toContain("border");
    expect(rule(site, ".closeTitle")).toContain("border-top: 1px solid var(--color-line);");
    expect(rule(site, ".closeTitle")).toContain("padding-top: var(--space-section);");
    // The hairline is the head's, inside the wrap.
    expect(rule(head, ".head")).toContain("border-top: 1px solid var(--color-line);");
    expect(rule(head, ".head .title")).toContain("max-width: 16em;");
  });

  it("leaves no trailing rule under the problem's numbers, where the next head's hairline follows", () => {
    expect(rule(site, ".numbers")).not.toContain("border-bottom");
    expect(rule(site, ".numbers")).toContain("border-top: 1px solid var(--color-line);");
  });
});
