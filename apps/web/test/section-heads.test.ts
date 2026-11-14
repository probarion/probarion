// The landing's shared section head and its one rhythm. Every section from the problem to the record opens the same
// way, through SectionHead.tsx: a hairline, the eyebrow, the heading and the lede, stacked on one left edge. Each
// owns G (--space-section) of paper below itself and none above, so the gap between any two sections is G. A block
// inside a section (SubHead) opens one level down, with an h3, after a hairline and --space-block.
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
  CONSOLE_SHOTS,
  HEADER_ANCHORS,
  INTEGRATE,
  JOURNEY,
  LIVE_CHECK,
  PROBLEM,
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

/** The landing's sections between the hero and the close, in page order, with the copy their heads read. */
const SECTIONS = [
  { id: "problem", eyebrow: PROBLEM.eyebrow, title: PROBLEM.title, lede: PROBLEM.sub },
  { id: "payment", eyebrow: JOURNEY.eyebrow, title: JOURNEY.title, lede: JOURNEY.intro },
  { id: "integrate", eyebrow: INTEGRATE.eyebrow, title: INTEGRATE.title, lede: INTEGRATE.lede },
  {
    id: "mainnet",
    eyebrow: MAINNET_HEAD.eyebrow,
    title: `${MAINNET_HEAD.line1} ${MAINNET_HEAD.line2}`,
    lede: MAINNET_HEAD.lede,
  },
  { id: "verify", eyebrow: TAMPER_COPY.eyebrow, title: TAMPER_COPY.title, lede: TAMPER_COPY.intro },
] as const;

/** The blocks inside a section that open with SubHead, each with the section it sits in and the copy its head reads. */
const BLOCKS = [
  {
    id: "try",
    in: "payment",
    eyebrow: LIVE_CHECK.eyebrow,
    title: LIVE_CHECK.title,
    lede: LIVE_CHECK.intro,
  },
] as const;

const html = renderToStaticMarkup(createElement(Home));
const start = (id: string) => html.indexOf(`<section class="${h.section}" id="${id}"`);
const block = (id: string) => html.indexOf(`<div class="${h.block}" id="${id}"`);
/** The closing's <section>, where the last section's part ends. */
const closing = html.lastIndexOf("<section", html.indexOf(`class="${s.close}"`));

describe("the landing's section heads", () => {
  it("open every section from the problem to the record with a hairline, the eyebrow, the heading and the lede", () => {
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
    }
  });

  it("open every block inside a section with a hairline, its eyebrow, an h3 and its lede, named by the h3", () => {
    for (const x of BLOCKS) {
      const head = new RegExp(
        `<div class="${h.block}" id="${x.id}" role="group" aria-labelledby="${x.id}-title">` +
          `<header class="${h.subHead}"><hgroup><p class="${s.eyebrow}">([^<]+)</p>` +
          `<h3 class="${h.subTitle}" id="${x.id}-title">([\\s\\S]*?)</h3></hgroup>` +
          `<p class="${h.lede} ${h.subLede}">([\\s\\S]*?)</p></header>`,
      ).exec(html);
      expect(head, x.id).not.toBeNull();
      expect(decode(head?.[1] ?? ""), x.id).toBe(x.eyebrow);
      expect(text(head?.[2] ?? ""), x.id).toBe(x.title);
      expect(text(head?.[3] ?? ""), x.id).toBe(plain(x.lede));
      // Each block is the anchor on its own: no section has its id.
      expect(start(x.id), x.id).toBe(-1);
    }
  });

  it("keeps the page order and every anchor the nav, the hero and other pages link to", () => {
    const at = SECTIONS.map((x) => start(x.id));
    for (const [i, x] of SECTIONS.entries()) expect(at[i], x.id).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Each block sits in its section: the live check (#try) under the payment steps, before the use cases.
    for (const x of BLOCKS) {
      const next = SECTIONS[SECTIONS.findIndex((y) => y.id === x.in) + 1];
      expect(block(x.id), x.id).toBeGreaterThan(start(x.in));
      expect(block(x.id), x.id).toBeLessThan(next ? start(next.id) : closing);
    }
    // The payee ends the problem; what it rests on and what works today follow the tamper test in #verify, and the
    // closing follows them.
    expect(html.indexOf('id="payee"')).toBeGreaterThan(start("problem"));
    expect(html.indexOf('id="payee"')).toBeLessThan(start("payment"));
    for (const id of [BUILT_ON.id, "status", "known-gaps"]) {
      expect(html.indexOf(`id="${id}"`), id).toBeGreaterThan(start("verify"));
      expect(html.indexOf(`id="${id}"`), id).toBeLessThan(closing);
    }
    expect(html.indexOf(`id="${BUILT_ON.id}"`)).toBeLessThan(html.indexOf('id="status"'));
    expect(closing).toBeGreaterThan(start("verify"));
    // The sections the page no longer shows: their content moved to the docs, or into another section.
    for (const id of ["compare", "chain", "console"]) expect(html, id).not.toContain(`id="${id}"`);
  });

  it("leaves none of the old head or spacing classes, and one head per section", () => {
    // No section uses them any more, so they are gone from the stylesheet.
    const css = read("src", "components", "site", "site.module.css");
    for (const old of [/\.section\b/, /\.flush\b/, /\.sectionHead\b/, /\.shots\b/, /\.boHead\b/])
      expect(css).not.toMatch(old);
    for (const [i, x] of SECTIONS.entries()) {
      const next = SECTIONS[i + 1];
      // The record's part ends where the closing's <section> opens.
      const part = html.slice(start(x.id), next ? start(next.id) : closing);
      expect(part.length, x.id).toBeGreaterThan(0);
      // One head per section: the eyebrow and the heading are not repeated in its body. A section that still sits
      // inside another brings its own head.
      const nested = part.split(`<section class="${h.section}"`).length - 2;
      expect(part.split(`class="${h.head}"`).length - 1 - nested, x.id).toBe(1);
    }
  });

  it("gives every section and the live check an eyebrow that adds no claim", () => {
    expect(PROBLEM.eyebrow).toBe("The problem");
    expect(LIVE_CHECK.eyebrow).toBe("Try it, live on NEAR testnet");
    expect(INTEGRATE.eyebrow).toBe("Use cases");
    expect(JOURNEY.eyebrow).toBe("How a payment works");
    expect(TAMPER_COPY.eyebrow).toBe("Verify a test ledger");
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

  it("defines the gap between blocks of one section once, in globals.css, and puts it above each block", () => {
    const defs = [...globals.matchAll(/--space-block:\s*([^;]+);/g)].map((m) => m[1]);
    expect(defs).toEqual(["clamp(40px, 5vw, 72px)"]);
    expect(head).not.toMatch(/--space-block:/);
    expect(rule(head, ".block")).toContain("margin-top: var(--space-block);");
    expect(rule(head, ".block")).toContain("border-top: 1px solid var(--color-line);");
  });

  it("puts G below each section and the hero, and none above a section", () => {
    expect(rule(head, ".section")).toContain("padding-block: 0 var(--space-section);");
    expect(rule(hero, ".hero")).toMatch(/padding-block: [^;]+ var\(--space-section\);/);
    // The closing's rule sits halfway down its gap, on the wrap's left edge like every head's hairline.
    expect(rule(site, ".close")).toContain("padding-block: 0 var(--space-section);");
    expect(rule(site, ".close")).not.toContain("border");
    expect(rule(site, ".closeTitle")).toContain("border-top: 1px solid var(--color-line);");
    expect(rule(site, ".closeTitle")).toContain("padding-top: var(--space-section);");
    // The hairline is the head's, inside the wrap.
    expect(rule(head, ".head")).toContain("border-top: 1px solid var(--color-line);");
    expect(rule(head, ".head .title")).toContain("max-width: 16em;");
  });

  it("insets the payee panel in the problem, with no paper of its own: the section owns G below it", () => {
    const panel = rule(site, ".payeePanel");
    expect(panel).toContain("border-radius: 24px;");
    expect(panel).toContain("background: var(--color-band);");
    expect(panel).not.toMatch(/margin|--space-section/);
    // The pull line before it keeps --space-block above and below, as a block does.
    expect(rule(site, ".pull")).toContain("margin-block: var(--space-block);");
    // The full-width ink band and the problem's numbers strip are gone, with their rules.
    for (const old of [/\.band\b/, /\.bandGrid\b/, /\.bandSub\b/, /\.numbers\s*[{>]/])
      expect(site).not.toMatch(old);
  });
});
