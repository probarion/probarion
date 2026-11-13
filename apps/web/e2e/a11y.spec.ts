import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// axe-core over the key pages of the built site with test settings (playwright.config.ts). Local only, like the smoke
// spec. Every WCAG 2.0, 2.1 and 2.2 A and AA rule runs, and then the AAA contrast rule (7:1, or 4.5:1 for large text)
// on its own. axe checks what a machine can: test/typography-aaa.test.ts holds the type scale, the spacing and the
// colour pairs, the last block below counts the laid-out lines and paragraph breaks of every docs article and public
// reading page (WCAG 1.4.8), and the rest of WCAG still needs a person. The test settings reach no database, so the
// proof page shows its unavailable view here, and the signed-in console pages are not in these lists.

const PAGES = [
  "/",
  "/status",
  "/docs",
  "/docs/concepts/payment-checks",
  "/proof/demo.vaults.probarion.testnet",
];

const AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Fixed, so no result depends on Playwright's defaults. Reduced motion shows every reveal in its final state at once.
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "light", reducedMotion: "reduce" });

async function load(page: Page, path: string) {
  await page.goto(path);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/** One line per failing node: the rule, the element and axe's own summary. */
function lines(violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]) {
  return violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}: ${n.failureSummary ?? v.help}`),
  );
}

for (const path of PAGES) {
  test.describe(path, () => {
    test("passes every WCAG 2.2 A and AA rule axe has", async ({ page }) => {
      await load(page, path);
      const result = await new AxeBuilder({ page }).withTags(AA_TAGS).analyze();
      expect(lines(result.violations)).toEqual([]);
    });

    test("passes the AAA contrast rule (1.4.6)", async ({ page }) => {
      await load(page, path);
      const result = await new AxeBuilder({ page })
        .withRules(["color-contrast-enhanced"])
        .analyze();
      expect(lines(result.violations)).toEqual([]);
    });

    // 1.4.10 at 320 CSS pixels (a 1280 pixel window at 400%), and 1.4.12 with its spacing set on every element.
    for (const spaced of [false, true]) {
      test(`reflows at 320px with no sideways scroll${spaced ? ", with the 1.4.12 text spacing" : ""}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 320, height: 800 });
        await load(page, path);
        if (spaced)
          await page.addStyleTag({
            content:
              "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }",
          });
        const { sideways, wide } = await page.evaluate(() => {
          const root = document.documentElement;
          const edge = root.clientWidth + 0.5;
          // An element past the right edge that no scrolling box of its own holds: what makes the page scroll sideways.
          const held = (el: Element) => {
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement)
              if (
                getComputedStyle(p).overflowX !== "visible" &&
                p.getBoundingClientRect().right <= edge
              )
                return true;
            return false;
          };
          const wide = [...document.body.querySelectorAll("*")]
            .filter((el) => el.getBoundingClientRect().right > edge && !held(el))
            .map(
              (el) =>
                `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} in ${el.parentElement?.className ?? ""}: ${(el.textContent ?? "").slice(0, 60)}`,
            )
            .slice(0, 12);
          return { sideways: root.scrollWidth - root.clientWidth, wide };
        });
        expect(sideways, wide.join("\n")).toBeLessThanOrEqual(0);
      });
    }

    // The site's 12px floor, as the browser computes it: test/typography-aaa.test.ts reads declared px sizes only, and
    // an em size through its parents (code at .site code's 0.86em in a 13.5px list is 11.6px) slips past it.
    for (const width of [320, 1440]) {
      test(`shows no text under 12px at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await load(page, path);
        const tiny = await page.evaluate(() => {
          const out: string[] = [];
          for (const el of document.body.querySelectorAll("*")) {
            const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
            if (!own) continue;
            const box = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            if (box.width <= 1 || box.height <= 1 || s.visibility === "hidden") continue;
            const size = Number.parseFloat(s.fontSize);
            if (size < 12)
              out.push(
                `${size.toFixed(2)}px ${el.tagName.toLowerCase()}: ${(el.textContent ?? "").trim().slice(0, 50)}`,
              );
          }
          return out;
        });
        expect(tiny).toEqual([]);
      });
    }
  });
}

// --- 1.4.8 as the browser lays it out ------------------------------------------------------------------------------

/** Every docs article, from content/docs, and every public page that is mostly text. */
function readingPages(): string[] {
  const root = fileURLToPath(new URL("../content/docs", import.meta.url));
  const docs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(join(root, d.name))
        .filter((f) => f.endsWith(".mdx"))
        .map((f) => `/docs/${d.name}/${f.replace(/\.mdx$/, "")}`),
    );
  return [
    "/",
    "/status",
    "/privacy",
    "/terms",
    "/security",
    "/canary",
    "/canary/rules",
    "/usage",
    "/login",
    "/extension",
    "/proof/demo.vaults.probarion.testnet",
    "/docs",
    ...docs.sort(),
  ];
}

/**
 * The reading text of the page's main landmark, as laid out: each line of a block of text over 80 characters, and each
 * pair of stacked paragraphs whose distance from the top of the first one's last line to the top of the second one's
 * first line is under 2.5em (W3C's reading of "paragraph spacing at least 1.5 times line spacing"). A block of text is
 * the nearest box around a run of text that is not inline. Code frames, tables, diagrams, screen-reader text and
 * mono labels are not reading text and are left out, and so is display text of 24px and up. Inline code in a sentence
 * counts.
 */
function measureReading() {
  const main = document.querySelector("main") ?? document.body;
  const SKIP = "pre, table, svg, [aria-hidden='true'], .sr-only";
  const blocks = new Map<Element, Element>();
  const blockOf = (el: Element): Element => {
    const known = blocks.get(el);
    if (known) return known;
    let found: Element = main;
    for (let e: Element | null = el; e && e !== main; e = e.parentElement)
      if (!getComputedStyle(e).display.startsWith("inline")) {
        found = e;
        break;
      }
    blocks.set(el, found);
    return found;
  };
  const reading = (block: Element) => {
    if (block.closest(SKIP)) return false;
    const s = getComputedStyle(block);
    return (
      Number.parseFloat(s.fontSize) < 24 &&
      !/Mono/.test(s.fontFamily) &&
      !/^(pre|nowrap)/.test(s.whiteSpace)
    );
  };
  const label = (el: Element) =>
    `${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${c}`).join("")}`;

  // Characters per line: a line ends where the next character starts left of the last one and below it.
  const perBlock = new Map<Element, { left: number; top: number; text: string }[]>();
  const range = document.createRange();
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    const text = n.textContent ?? "";
    if (!parent || !text.trim() || parent.closest(SKIP)) continue;
    const block = blockOf(parent);
    if (!perBlock.has(block) && !reading(block)) continue;
    const lines = perBlock.get(block) ?? [];
    perBlock.set(block, lines);
    for (let i = 0; i < text.length; i++) {
      range.setStart(n, i);
      range.setEnd(n, i + 1);
      const r = range.getClientRects()[0];
      if (!r || r.width === 0) continue;
      const last = lines[lines.length - 1];
      if (!last || (r.left < last.left - 1 && r.top > last.top + 1))
        lines.push({ left: r.left, top: r.top, text: text[i] ?? "" });
      else {
        last.text += text[i];
        last.left = r.left;
      }
    }
  }
  const long: string[] = [];
  for (const [block, lines] of perBlock)
    for (const l of lines) {
      const t = l.text.replace(/\s+/g, " ").trim();
      if (t.length > 80)
        long.push(`${label(block)}: ${t.length} characters: "${t.slice(0, 48)}..."`);
    }

  // Paragraph breaks: each p that follows a p, stacked below it.
  const close: string[] = [];
  for (const second of main.querySelectorAll("p + p")) {
    const first = second.previousElementSibling;
    if (!first || first.closest(SKIP) || second.closest(SKIP)) continue;
    const [a, b] = [first.getBoundingClientRect(), second.getBoundingClientRect()];
    if (a.height === 0 || b.height === 0 || b.top < a.bottom - 1) continue;
    const [sa, sb] = [getComputedStyle(first), getComputedStyle(second)];
    const px = (v: string) => Number.parseFloat(v) || 0;
    // Display text, and a mono label over its text (an eyebrow), are not paragraphs.
    if (px(sa.fontSize) >= 24 || /Mono/.test(sa.fontFamily)) continue;
    const size = Math.max(px(sa.fontSize), px(sb.fontSize));
    const lineHeight = px(sa.lineHeight) || px(sa.fontSize) * 1.2;
    const lastLineTop = a.bottom - px(sa.paddingBottom) - px(sa.borderBottomWidth) - lineHeight;
    const firstLineTop = b.top + px(sb.paddingTop) + px(sb.borderTopWidth);
    const em = (firstLineTop - lastLineTop) / size;
    if (em < 2.5 - 0.01)
      close.push(
        `${label(first)} + ${label(second)}: ${em.toFixed(2)}em: "${(second.textContent ?? "").trim().slice(0, 40)}"`,
      );
  }
  return { long, close };
}

test.describe("reading text as laid out at 1440px (WCAG 1.4.8)", () => {
  for (const path of readingPages()) {
    test(`${path}: lines of 80 characters or fewer, paragraphs 2.5em apart`, async ({ page }) => {
      await load(page, path);
      const { long, close } = await page.evaluate(measureReading);
      expect(long, "lines over 80 characters").toEqual([]);
      expect(close, "paragraph breaks under 2.5em").toEqual([]);
    });
  }
});
