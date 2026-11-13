import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isTestFile, toPosix, walk } from "./deploy-scan";

/*
 * The site's typography against WCAG 2.2: contrast at AAA (1.4.6: 7:1, or 4.5:1 for large text), the visual
 * presentation of reading text (1.4.8), readable sizes and weights, and the guards that keep text spacing (1.4.12) and
 * reflow (1.4.10) working. Every check reads the real files: the tokens in app/globals.css and the CSS modules in MODULES.
 * Large text is 24px and up (18.66px bold and up; no module sets a weight above 600). What is left out is listed below,
 * each with its reason.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(WEB, "src");
const read = (...parts: string[]) => readFileSync(join(WEB, ...parts), "utf8");
const GLOBALS = read("src", "app", "globals.css");
const MODULES: Readonly<Record<string, string>> = {
  site: "src/components/site/site.module.css",
  docs: "src/components/docs/docs.module.css",
  canary: "src/components/site/canary.module.css",
  usage: "src/components/site/usage.module.css",
  head: "src/components/site/head.module.css",
  journey: "src/components/site/journey.module.css",
  integrate: "src/components/site/integrate.module.css",
  console: "src/components/site/console.module.css",
  hero: "src/components/site/hero.module.css",
  compare: "src/components/site/compare.module.css",
  tamper: "src/components/site/tamper.module.css",
  chain: "src/components/site/chain.module.css",
};
const AAA = 7;
const AAA_LARGE = 4.5;
const LARGE_PX = 24;

// --- Colour -----------------------------------------------------------------------------------------------------

const TOKENS = Object.fromEntries(
  [...GLOBALS.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]),
) as Record<string, string>;
const WHITE = "#ffffff";
function token(name: string): string {
  const hex = TOKENS[name];
  if (!hex) throw new Error(`token --color-${name} not found`);
  return hex;
}
const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const toHex = (c: number[]) =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** `fg` at `alpha` painted over `bg`, as the browser blends it in sRGB. */
function over(fg: string, alpha: number, bg: string): string {
  const [f, b] = [channels(fg), channels(bg)];
  return toHex(f.map((v, i) => v * alpha + (b[i] ?? 0) * (1 - alpha)));
}

// --- A small CSS reader: rules with their selectors, declarations and enclosing at-rules ---------------------------

type Rule = { file: string; selectors: string[]; decls: Record<string, string>; at: string[] };

/** Splits on `sep` outside parentheses, brackets and quotes. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function parse(css: string, file: string, at: string[] = []): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    let prelude = src.slice(i, open);
    prelude = prelude.slice(prelude.lastIndexOf(";") + 1).trim();
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    const body = src.slice(open + 1, j - 1);
    if (prelude.startsWith("@keyframes") || prelude.startsWith("@theme")) {
      // Keyframes hold no text colour; the theme's tokens are read above.
    } else if (prelude.startsWith("@")) out.push(...parse(body, file, [...at, prelude]));
    else {
      const decls: Record<string, string> = {};
      for (const d of splitTop(body, ";")) {
        const colon = d.indexOf(":");
        if (colon > 0) decls[d.slice(0, colon).trim()] = d.slice(colon + 1).trim();
      }
      out.push({ file, selectors: splitTop(prelude, ","), decls, at });
    }
    i = j;
  }
  return out;
}

const RULES: Rule[] = [
  ...parse(GLOBALS, "globals"),
  ...Object.entries(MODULES).flatMap(([name, path]) => parse(read(path), name)),
];
const MODULE_RULES = RULES.filter((r) => r.file !== "globals");
const forced = (r: Rule) => r.at.some((a) => a.includes("forced-colors"));
const where = (r: Rule) => `${r.file}: ${r.selectors.join(", ")}`;
/** The declarations of every rule in `file`, whatever its media, whose selector list holds `selector` exactly. */
function declsOf(file: string, selector: string): Record<string, string>[] {
  return RULES.filter((r) => r.file === file && r.selectors.includes(selector)).map((r) => r.decls);
}
function decl(file: string, selector: string, prop: string): string {
  const found = declsOf(file, selector)
    .map((d) => d[prop])
    .filter(Boolean);
  if (found.length === 0) throw new Error(`${file}: ${selector} sets no ${prop}`);
  return found[0] ?? "";
}

/** The smallest size a font-size can take, in px: a px value, clamp()'s or max()'s floor. Undefined for em and %. */
function minPx(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const px = /^([\d.]+)px$/.exec(value);
  if (px) return Number(px[1]);
  const clamp = /^clamp\(\s*([\d.]+)px/.exec(value);
  if (clamp) return Number(clamp[1]);
  const max = /^max\(\s*([\d.]+)px/.exec(value);
  if (max) return Number(max[1]);
  return undefined;
}

// --- Which grounds a text colour sits on ----------------------------------------------------------------------------

/** Text colours made for ink: their ground is the band, or the lighter ink of an active code tab or a hovered button. */
const ON_INK = new Set(["paper", "band-fg", "band-mute", "band-bad", "gold-bright", "gold-light"]);
const INK_GROUNDS = ["band", "code-active"];
/** Every other text colour sits on the page, a white card or the docs' soft fill, unless its own rule paints a fill. */
const LIGHT_GROUNDS = ["paper", "surface", "soft"];

/**
 * The paid card's grounds, from --gradient-metal: each stop of its linear sweep from 34% on, its 0% stop under the pale
 * highlight (alpha 0.46 at the corner, whatever the card's size), and its end stop under the dark corner at full alpha,
 * which is darker than any point the text reaches. Ink is held to all of them. The card's quieter labels (--c-mute) are
 * left-aligned, away from the dark corner at the bottom right, so they are held to the stops and the highlight.
 */
function metalGrounds(): { all: string[]; labels: string[] } {
  const g = /--gradient-metal:([\s\S]*?);/.exec(GLOBALS)?.[1] ?? "";
  const rgba = [...g.matchAll(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/g)].map((m) => ({
    hex: toHex([Number(m[1]), Number(m[2]), Number(m[3])]),
    alpha: Number(m[4]),
  }));
  const linear = /linear-gradient\(([^)]*)\)\s*$/.exec(g.trim())?.[1] ?? "";
  const stops = [...linear.matchAll(/(#[0-9a-f]{6})\s+(\d+)%/gi)].map((m) => ({
    hex: m[1] ?? "",
    at: Number(m[2]),
  }));
  const [highlight, dark] = [rgba[0], rgba[2]];
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!highlight || !dark || !first || !last)
    throw new Error("--gradient-metal is not as expected");
  const corner = over(highlight.hex, highlight.alpha * (1 - 0.263 / 0.62), first.hex);
  const sweep = stops.filter((s) => s.at >= 34).map((s) => s.hex);
  return {
    all: [...sweep, corner, over(dark.hex, dark.alpha, last.hex)],
    labels: [...sweep, corner],
  };
}
const METAL = metalGrounds();

/** The cards that set --c-fg and --c-mute, and the grounds each puts them on. */
const CARD_CONTEXTS = [
  { card: ".metal", fg: METAL.all, mute: METAL.labels },
  { card: ".obsidian", fg: ["band"], mute: ["band"] },
];
const cardVar = (card: string, name: string) => decl("site", card, `--c-${name}`);

type Paint = { hex: string; alpha: number };
/** A colour value as a hex and an alpha, or undefined when it is not a fixed colour (inherit, currentColor, a system colour). */
function paint(value: string, card?: string): Paint | undefined {
  const v = value.replace(/\s*!important$/, "").trim();
  const tok = /^var\(--color-([a-z-]+)\)$/.exec(v);
  if (tok) return { hex: token(tok[1] ?? ""), alpha: 1 };
  const local = /^var\(--c-(fg|mute|line)\)$/.exec(v);
  if (local && card) return paint(cardVar(card, local[1] ?? ""), card);
  const mix = /^color-mix\(in srgb,\s*(var\(--color-[a-z-]+\))\s+(\d+)%,\s*(.+)\)$/.exec(v);
  if (mix) {
    const a = paint(mix[1] ?? "");
    const pct = Number(mix[2]) / 100;
    if (!a) return undefined;
    if (mix[3] === "transparent") return { hex: a.hex, alpha: pct };
    const b = paint(mix[3] ?? "");
    return b ? { hex: over(a.hex, pct, b.hex), alpha: 1 } : undefined;
  }
  if (v === "#fff" || v === "white") return { hex: WHITE, alpha: 1 };
  return undefined;
}

type Pair = { where: string; fg: string; ground: string; ratio: number; large: boolean };

/** Every text colour in the stylesheets, against each ground it can sit on. */
function textPairs(): Pair[] {
  const out: Pair[] = [];
  for (const r of RULES) {
    const colour = r.decls.color;
    if (!colour || forced(r)) continue;
    const large = (minPx(r.decls["font-size"]) ?? 0) >= LARGE_PX;
    const usesCard = /var\(--c-/.test(colour);
    // A rule on the card itself (.metal, .obsidian) is in that card only; any other rule may sit in either.
    const named = CARD_CONTEXTS.filter((c) => r.selectors.some((s) => s.includes(c.card)));
    const contexts = usesCard
      ? (named.length > 0 ? named : CARD_CONTEXTS).map((c) => ({
          card: c.card,
          grounds: /--c-mute/.test(colour) ? c.mute : c.fg,
        }))
      : [{ card: undefined, grounds: undefined as string[] | undefined }];
    for (const ctx of contexts) {
      const fg = paint(colour, ctx.card);
      if (!fg) continue;
      const fill = r.decls.background ?? r.decls["background-color"];
      const own = fill ? paint(fill, ctx.card) : undefined;
      const name = /^var\(--color-([a-z-]+)\)$/.exec(colour.trim())?.[1] ?? "";
      let grounds: string[];
      if (own && own.alpha === 1) grounds = [own.hex];
      else if (fill === "var(--gradient-metal)") grounds = METAL.all;
      else if (ctx.grounds) grounds = ctx.grounds.map((g) => (g.startsWith("#") ? g : token(g)));
      else grounds = (ON_INK.has(name) ? INK_GROUNDS : LIGHT_GROUNDS).map(token);
      for (const ground of grounds) {
        const hex = fg.alpha === 1 ? fg.hex : over(fg.hex, fg.alpha, ground);
        out.push({
          where: `${where(r)}${ctx.card ? ` (in ${ctx.card})` : ""}`,
          fg: hex,
          ground,
          ratio: contrast(hex, ground),
          large,
        });
      }
    }
  }
  return out;
}

/**
 * Text that one rule colours and another rule fills, which the scan above cannot pair from one rule. Each is the
 * colour, the fill, and where it is.
 */
const NESTED: readonly [string, string, string][] = [
  ["mute", "wait-bg", "docs: .warning .calloutFooter, a callout's footer on its wait tint"],
  ["ink", "wait-bg", "docs: .warning callout text"],
  ["bad", "bad-bg", "site: .hit .num and .rowNote on a struck row's red tint"],
  ["ink", "soft", "docs: inline code in prose, on its soft fill"],
  ["gold-ink", "soft", "docs: .searchOption mark in the selected option's soft fill"],
  [
    "ink",
    "gold-pale",
    "docs: .archLabel and .archDetail on the people boxes of the architecture diagram",
  ],
  ["ink", "soft", "docs: .archLabel and .archDetail on the outside boxes"],
  ["paper", "ink", "docs: .archLabel and .archDetail on the chain boxes"],
  ["ink", "paper", "docs: .archEdgeLabel, painted over a paper stroke"],
];

/**
 * Pairs below 7:1 that WCAG does not hold to it, with the reason. A pair is named by where it is and its colour pair,
 * so a new use of the same colours elsewhere is still checked.
 */
const ALLOWED_LOW: readonly { where: RegExp; why: string }[] = [
  // None today: every text colour in the modules reads at 7:1, or 4.5:1 where its rule makes it large text.
];

describe("text contrast at WCAG AAA (1.4.6), from the tokens and the CSS modules", () => {
  const pairs = textPairs();

  it("finds the site's text colours, the paid card's and the ink surfaces' among them", () => {
    expect(pairs.length).toBeGreaterThan(150);
    expect(pairs.some((p) => p.where.includes(".rows dt") && p.where.includes(".metal"))).toBe(
      true,
    );
    expect(pairs.some((p) => p.where.includes("docs: .tab"))).toBe(true);
    expect(pairs.some((p) => p.where.includes("globals: ::placeholder"))).toBe(true);
  });

  it("reads every text colour at 7:1 on each ground it sits on, or 4.5:1 where its rule makes it large", () => {
    const low = pairs
      .filter((p) => p.ratio < (p.large ? AAA_LARGE : AAA))
      .filter((p) => !ALLOWED_LOW.some((a) => a.where.test(p.where)))
      .map((p) => `${p.where}: ${p.fg} on ${p.ground} = ${p.ratio.toFixed(2)}:1`);
    expect([...new Set(low)]).toEqual([]);
  });

  it("reads the pairs one rule colours and another fills at 7:1", () => {
    for (const [fg, bg, at] of NESTED) {
      expect(contrast(token(fg), token(bg)), at).toBeGreaterThanOrEqual(AAA);
    }
  });

  it("keeps gold-small off small text: only the 42px step numbers, a large text, use it as a text colour", () => {
    const uses = MODULE_RULES.filter((r) => r.decls.color === "var(--color-gold-small)");
    expect(uses.map(where)).toEqual(["journey: .stepN"]);
    for (const r of uses) expect(minPx(r.decls["font-size"]), where(r)).toBeGreaterThanOrEqual(24);
    const tsx = walk(SRC).filter((f) => f.endsWith(".tsx") && !isTestFile(f));
    const found = tsx.filter((f) =>
      /(?<=^|[\s"'`:])text-gold-(?:small|deep)\b/.test(readFileSync(f, "utf8")),
    );
    expect(found.map((f) => toPosix(relative(SRC, f)))).toEqual([]);
  });

  it("keeps the gold headline at 4.5:1 on paper all along its sweep, as large text needs at AAA", () => {
    const gradient = /--gradient-gold-text:\s*linear-gradient\(([^;]+)\);/.exec(GLOBALS)?.[1] ?? "";
    const stops = [...gradient.matchAll(/(#[0-9a-f]{6})\s+\d+%/gi)].map((m) => m[1] ?? "");
    expect(stops.length).toBeGreaterThan(1);
    let lowest = Number.POSITIVE_INFINITY;
    for (const [i, stop] of stops.slice(1).entries()) {
      const from = channels(stops[i] ?? stop);
      const to = channels(stop);
      for (let t = 0; t <= 1.0001; t += 0.01) {
        const c = toHex(from.map((v, k) => v + ((to[k] ?? v) - v) * t));
        lowest = Math.min(lowest, contrast(c, token("paper")));
      }
    }
    expect(lowest).toBeGreaterThanOrEqual(AAA_LARGE);
    // Only large display headings wear it.
    for (const [file, selector] of [
      ["site", ".h1"],
      ["site", ".closeTitle"],
      ["docs", ".heroTitle"],
    ] as const) {
      for (const d of declsOf(file, selector).filter((x) => x["font-size"])) {
        expect(minPx(d["font-size"]), `${file} ${selector}`).toBeGreaterThanOrEqual(LARGE_PX);
      }
    }
  });

  it("keeps the nav's mute text at 7:1 under the sticky header when the ink band scrolls beneath it", () => {
    const bg = decl("site", ".siteHeader", "background");
    const pct = Number(/var\(--color-paper\)\s+(\d+)%/.exec(bg)?.[1]);
    expect(pct).toBeGreaterThan(0);
    const ground = over(token("paper"), pct / 100, token("band"));
    expect(contrast(token("mute"), ground)).toBeGreaterThanOrEqual(AAA);
    // The focus ring there still meets 3:1 (WCAG 2.4.13).
    expect(contrast(token("gold-small"), ground)).toBeGreaterThanOrEqual(3);
  });

  it("keeps a placeholder in mute, not the half-transparent default", () => {
    const rule = RULES.find((r) => r.file === "globals" && r.selectors.includes("::placeholder"));
    expect(rule?.decls.color).toBe("var(--color-mute)");
    expect(rule?.decls.opacity).toBe("1");
    expect(contrast(token("mute"), WHITE)).toBeGreaterThanOrEqual(AAA);
  });

  it("dims a disabled control and keeps its label legible, at 4.5:1 or more (disabled controls are exempt from 1.4.6)", () => {
    const opacities = [
      ...MODULE_RULES.filter((r) => r.selectors.some((s) => /disabled/.test(s)) && r.decls.opacity),
    ].map((r) => ({ at: where(r), alpha: Number(r.decls.opacity) }));
    const tsx = walk(SRC).filter((f) => f.endsWith(".tsx") && !isTestFile(f));
    for (const f of tsx) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bdisabled:opacity-(\d+)\b/g)) {
        opacities.push({ at: toPosix(relative(SRC, f)), alpha: Number(m[1]) / 100 });
      }
    }
    expect(opacities.length).toBeGreaterThan(4);
    for (const { at, alpha } of opacities) {
      // An ink pill over a white card: its paper label and its ink fill both fade.
      const pill = contrast(over(token("paper"), alpha, WHITE), over(token("ink"), alpha, WHITE));
      const text = contrast(over(token("ink"), alpha, WHITE), WHITE);
      expect(Math.min(pill, text), at).toBeGreaterThanOrEqual(AAA_LARGE);
    }
    // The red buttons (a danger dialog's action, the red outline beside Approve) dim less: red text on a white card, or
    // white on a red fill, both fade toward white.
    const ui = read("src", "components", "ui.tsx");
    const red = Number(/const redButton = `[^`]*\bdisabled:opacity-(\d+)\b/.exec(ui)?.[1]) / 100;
    expect(red).toBeGreaterThan(0);
    for (const name of ["dangerButtonClass", "dangerLineButtonClass"]) {
      expect(ui, name).toContain(`export const ${name} = \`\${redButton} `);
    }
    expect(contrast(over(token("bad"), red, WHITE), WHITE)).toBeGreaterThanOrEqual(AAA_LARGE);
  });

  it("keeps an input's edge at 3:1 on the panel it sits on (WCAG 1.4.11)", () => {
    for (const [file, selector] of [
      ["site", ".field select"],
      ["site", ".accountInput"],
      ["canary", ".textarea"],
    ] as const) {
      const border = decl(file, selector, "border");
      const colour = /var\(--color-([a-z-]+)\)/.exec(border)?.[1] ?? "";
      expect(contrast(token(colour), WHITE), `${file} ${selector}`).toBeGreaterThanOrEqual(3);
    }
    // The open code tab is marked by a gold bar, not only by a fill 1.2:1 from the head's.
    const tab = decl("docs", '.tab[aria-selected="true"]', "box-shadow");
    expect(tab).toBe("inset 0 -2px 0 var(--color-gold-bright)");
    expect(contrast(token("gold-bright"), token("band"))).toBeGreaterThanOrEqual(3);
  });

  /** Opacity on something that holds text lowers its contrast, so each use is either disabled (above) or listed. */
  const OPACITY_OK: readonly [RegExp, string][] = [
    [/site: \.metal::after/, "the paid card's noise texture: no text"],
    [/docs: \.anchor/, "a heading's # link: 0 until hovered or focused, then 1"],
    [
      /docs: \.crumbs li \+ li::before/,
      "the / between crumbs: decoration, the list carries the order",
    ],
    [/docs: \.prose h2:hover \.anchor/, "the anchor shown at full opacity"],
  ];

  it("lowers opacity only on disabled controls, decoration or hidden states", () => {
    const found = MODULE_RULES.filter((r) => r.decls.opacity !== undefined)
      .filter((r) => !r.selectors.some((s) => /disabled/.test(s)))
      .map(where)
      .filter((w) => !OPACITY_OK.some(([re]) => re.test(w)));
    expect(found).toEqual([]);
  });
});

// --- Visual presentation (1.4.8), sizes and weights ------------------------------------------------------------------

/**
 * Selectors that set a tight line for one line of text, not a block: the logo, a button's label, a one-glyph mark, and
 * `.boName`, the Built on section's `h3` ("NEAR AI Cloud"), set as tall as NEAR's logo beside it.
 */
const TIGHT_LINE_OK = new Set([".brand", ".scenario", ".pick", ".tipMark", ".boName"]);
const HEADING = /(?:^|[\s>+~])h[1-6]\b|title|Title|\.h[12]\b/;

describe("reading text (WCAG 1.4.8, sizes and weights)", () => {
  it("sets line-height 1.5 or more on every block of text; tighter only on headings, large text and one-line controls", () => {
    const low: string[] = [];
    for (const r of MODULE_RULES) {
      const lh = r.decls["line-height"];
      if (!lh || !/^[\d.]+$/.test(lh) || Number(lh) >= 1.5) continue;
      const sizes = declsOf(r.file, r.selectors[0] ?? "")
        .map((d) => minPx(d["font-size"]))
        .filter((n): n is number => n !== undefined);
      const large = sizes.length > 0 && Math.min(...sizes) >= LARGE_PX;
      const ok = r.selectors.every((s) => HEADING.test(s) || TIGHT_LINE_OK.has(s));
      if (!large && !ok) low.push(`${where(r)}: ${lh}`);
    }
    expect(low).toEqual([]);
    for (const [file, selector] of [
      ["site", ".site"],
      ["site", ".lede"],
      ["site", ".proofIntro"],
      ["tamper", ".checkHint"],
      ["tamper", ".plain"],
      ["canary", ".lede"],
      ["canary", ".tip"],
      ["docs", ".prose"],
      ["docs", ".callout"],
    ] as const) {
      expect(
        Number(decl(file, selector, "line-height")),
        `${file} ${selector}`,
      ).toBeGreaterThanOrEqual(1.5);
    }
  });

  it("aligns no text to both edges", () => {
    expect(RULES.filter((r) => r.decls["text-align"] === "justify").map(where)).toEqual([]);
    const tsx = walk(SRC).filter((f) => f.endsWith(".tsx") && !isTestFile(f));
    expect(tsx.filter((f) => /\btext-justify\b/.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("leaves 2.5em or more from the top of a paragraph's last line to the top of the next one's first", () => {
    // W3C's reading of "paragraph spacing 1.5 times the line spacing" (Understanding 1.4.8): the top of the last line
    // of one paragraph is 250% of a single space from the top of the first line of the next. So line-height plus the
    // gap, both in em of the text, must reach 2.5.
    const em = (value: string, px: number) => {
      const m = /^([\d.]+)(px|em)$/.exec(value.trim());
      if (!m) throw new Error(`not a length: ${value}`);
      return m[2] === "em" ? Number(m[1]) : Number(m[1]) / px;
    };
    const cases: [string, string, string, number, string, string][] = [
      // file, selector, gap property, text size in px, where the line height is set (file, selector)
      ["docs", ".prose > * + *", "margin-top", 16.5, "docs", ".prose"],
      ["docs", ".calloutBody > * + *", "margin-top", 15.5, "docs", ".callout"],
      ["docs", ".check > * + *", "margin-top", 16.5, "docs", ".prose"],
      ["docs", ".agents > * + *", "margin-top", 16.5, "docs", ".prose"],
      ["docs", ".prose li > :is(p, ul, ol) + :is(p, ul, ol)", "margin-top", 16.5, "docs", ".prose"],
      ["site", ".gaps li + li", "margin-top", 15, "site", ".site"],
      ["site", ".boFine p + p", "margin-top", 13, "site", ".site"],
      ["canary", ".column p + p", "margin-top", 17, "site", ".site"],
      ["canary", ".line", "margin-top", 17, "site", ".site"],
      ["canary", ".steps", "gap", 16, "site", ".site"],
      ["canary", ".rules", "gap", 16, "site", ".site"],
      ["canary", ".reading :where(p + p)", "margin-top", 17, "site", ".site"],
      ["usage", ".defs", "gap", 16, "site", ".site"],
      // The journey: a step's note under its text, the note's lines, the record's caption over its intro, an invoice's
      // asked, happened and evidence stacked on a tablet or a phone, and the two lines under the attested decisions.
      ["journey", ".note", "margin-top", 15, "journey", ".note"],
      ["journey", ".noteLine + .noteLine", "margin-top", 15, "journey", ".note"],
      ["journey", ".recHead", "row-gap", 16, "site", ".site"],
      ["journey", ".invRow", "row-gap", 15, "site", ".site"],
      ["journey", ".attFoot", "gap", 15, "journey", ".attFoot"],
      // Integrate: a use's control over its runs when the columns stack, and a run's outcome over its evidence.
      ["integrate", ".use", "row-gap", 15, "site", ".site"],
      ["integrate", ".run", "row-gap", 15, "site", ".site"],
      // The console: the record under the head's lede, and a capture's full-size link over its transaction.
      ["console", ".record", "margin-top", 17, "site", ".site"],
      ["console", ".ev", "gap", 15, "site", ".site"],
      // The chain: a row's call, what the chain shows and its transaction stacked, and the foot's two lines.
      ["chain", ".row", "row-gap", 15, "site", ".site"],
      ["chain", ".foot", "gap", 15, "site", ".site"],
      // The hero: one step of the Canary's rehearsal under the next.
      ["hero", ".steps li + li", "margin-top", 14, "hero", ".steps"],
    ];
    for (const [file, selector, prop, px, lhFile, lhSelector] of cases) {
      const lh = Number(decl(lhFile, lhSelector, "line-height"));
      const total = lh + em(decl(file, selector, prop), px);
      expect(total + 1e-9, `${file} ${selector}`).toBeGreaterThanOrEqual(2.5);
    }
    // The footer is outside .site: its line height is the page's 1.5.
    expect(1.5 + em(decl("site", ".footNote", "margin-top"), 14)).toBeGreaterThanOrEqual(2.5);
  });

  it("caps reading text at about 71 characters a line on average, from Hanken Grotesk's own average width", () => {
    const require = createRequire(import.meta.url);
    const metrics = require("next/dist/server/capsize-font-metrics.json") as Record<
      string,
      { familyName: string; unitsPerEm: number; subsets: { latin: { xWidthAvg: number } } }
    >;
    const hanken = Object.values(metrics).find((m) => m.familyName === "Hanken Grotesk");
    if (!hanken) throw new Error("no metrics for Hanken Grotesk");
    const average = hanken.subsets.latin.xWidthAvg / hanken.unitsPerEm;
    const measure = Number(/--container-measure:\s*([\d.]+)em;/.exec(GLOBALS)?.[1]);
    // An average of 75 or fewer leaves room for a line of narrow letters; e2e/a11y.spec.ts counts the laid-out lines.
    expect(measure / average).toBeLessThanOrEqual(75);
    // A tight step holds its own text: its cap adds the 44px number gutter that its padding takes.
    const step = ".steps ol > li:not(:has(> :is(figure, pre, div, table)))";
    expect(decl("docs", step, "max-width")).toBe(
      `calc(var(--container-measure) + ${decl("docs", ".steps ol > li", "padding-left")})`,
    );
    const capped: [string, string][] = [
      ["site", ".lede"],
      ["journey", ".stepBody"],
      ["journey", ".note"],
      ["journey", ".recLede"],
      ["journey", ".attCap"],
      ["journey", ".attFoot p"],
      ["site", ".statusNote"],
      ["site", ".gaps"],
      ["site", ".closeNote"],
      ["integrate", ".partNote"],
      ["integrate", ".useBody"],
      ["console", ".actionsText"],
      ["hero", ".cap"],
      ["hero", ".steps"],
      // The ledger test: the verdict's sentence, the run note and a press that did not finish.
      ["tamper", ".plain"],
      ["tamper", ".note"],
      ["tamper", ".runError"],
      ["site", ".proofIntro"],
      ["compare", ".moreLink"],
      ["compare", ".moreNote"],
      ["chain", ".body"],
      ["chain", ".foot"],
      ["site", ".boFine"],
      ["head", ".lede"],
      ["docs", ".prose > :is(p, ul, ol, blockquote)"],
      ["docs", ".prose li > :is(p, ul, ol)"],
      ["docs", ".check > p"],
      ["docs", ".agents > :is(p, ul)"],
      ["docs", ".meta > span"],
      ["docs", ".lede"],
      ["docs", ".heroLede"],
      ["canary", ".lede"],
      ["canary", ".rules"],
      ["canary", ".reading :where(p, ul, ol)"],
      ["canary", ".meanwhile"],
      ["canary", ".banner"],
      ["canary", ".line"],
      ["usage", ".defs"],
    ];
    for (const [file, selector] of capped) {
      const width = decl(file, selector, "max-width");
      const ok =
        width === "var(--container-measure)" ||
        (/^([\d.]+)em$/.test(width) && Number.parseFloat(width) <= measure);
      expect(ok, `${file} ${selector}: ${width}`).toBe(true);
    }
  });

  it("keeps the light weight (300 or less) for large text, 24px and up", () => {
    const thin: string[] = [];
    for (const r of MODULE_RULES) {
      const w = r.decls["font-weight"];
      if (!w || !/^\d+$/.test(w) || Number(w) > 300) continue;
      for (const s of r.selectors) {
        const sizes = declsOf(r.file, s)
          .map((d) => d["font-size"])
          .filter((v): v is string => v !== undefined);
        const px = sizes.map(minPx);
        if (sizes.length === 0 || px.some((n) => n === undefined || n < LARGE_PX)) {
          thin.push(`${r.file}: ${s} (${sizes.join(", ") || "no size"})`);
        }
      }
    }
    expect(thin).toEqual([]);
    const tsx = walk(SRC).filter((f) => f.endsWith(".tsx") && !isTestFile(f));
    const small: string[] = [];
    // Every class string (a className or a constant) that sets a light weight also sets text-2xl (24px) or larger as
    // its base size.
    for (const f of tsx) {
      for (const m of readFileSync(f, "utf8").matchAll(
        /["`]([^"`\n]*\bfont-(?:light|extralight|thin)\b[^"`\n]*)["`]/g,
      )) {
        const cls = m[1] ?? "";
        if (!/(?:^|\s)text-(?:[2-9]xl)\b/.test(cls))
          small.push(`${toPosix(relative(SRC, f))}: ${cls}`);
      }
    }
    expect(tsx.some((f) => /\bfont-light\b/.test(readFileSync(f, "utf8")))).toBe(true);
    expect(small).toEqual([]);
  });

  it("sets no text under 12px, mono labels included", () => {
    const tiny: string[] = [];
    for (const r of MODULE_RULES) {
      const px = minPx(r.decls["font-size"]);
      if (px !== undefined && px < 12) tiny.push(`${where(r)}: ${r.decls["font-size"]}`);
    }
    expect(tiny).toEqual([]);
    const tsx = walk(SRC).filter((f) => f.endsWith(".tsx") && !isTestFile(f));
    const found = tsx.flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/\btext-\[(\d+(?:\.\d+)?)px\]/g)]
        .filter((m) => Number(m[1]) < 12)
        .map((m) => `${toPosix(relative(SRC, f))}: ${m[0]}`),
    );
    expect(found).toEqual([]);
    // Code in a docs table head keeps the head's 12px.
    expect(decl("docs", ".tableWrap th code", "font-size")).toBe("1em");
  });
});

// --- Text spacing (1.4.12), reflow (1.4.10), focus, schemes ----------------------------------------------------------

describe("text spacing, reflow, focus and colour schemes", () => {
  it("clips no text with an ellipsis: wider letter and word spacing (1.4.12) wraps a label instead", () => {
    expect(MODULE_RULES.filter((r) => r.decls["text-overflow"] === "ellipsis").map(where)).toEqual(
      [],
    );
    for (const box of [".searchTrigger", ".bigSearch"]) {
      const d = declsOf("docs", box)[0] ?? {};
      expect(d.height, box).toBeUndefined();
      expect(d["min-height"], box).toMatch(/px$/);
    }
    // A long status pill wraps inside itself rather than run past a 320px column (1.4.10).
    expect(decl("site", ".pillInline", "white-space")).toBe("normal");
    expect(decl("site", ".pillInline", "max-width")).toBe("100%");
  });

  it("positions every sideways scroller, so screen-reader text inside cannot widen the page (1.4.10)", () => {
    const loose = MODULE_RULES.filter((r) => r.decls["overflow-x"] === "auto")
      .filter((r) => !forced(r) && r.at.length === 0)
      .filter(
        (r) => !r.selectors.every((s) => declsOf(r.file, s).some((d) => d.position === "relative")),
      )
      .map(where);
    expect(loose).toEqual([]);
  });

  it("rings every focusable control the same way, selects and text areas included, and the docs search input all round", () => {
    const base = RULES.find(
      (r) => r.file === "globals" && r.selectors.some((s) => s.includes(":focus-visible")),
    );
    expect(base?.selectors[0]).toContain("select");
    expect(base?.selectors[0]).toContain("textarea");
    expect(base?.decls.outline).toBe("2px solid var(--color-gold-small)");
    const search = declsOf("docs", ".searchInput:focus-visible")[0] ?? {};
    expect(search.outline).toBe("2px solid var(--color-gold-small)");
    expect(search["box-shadow"]).toBeUndefined();
    // Rings that a clipping box would cut are drawn inside it.
    for (const s of [".codeBody:focus-visible", ".scroll:focus-visible"]) {
      expect(decl("site", s, "outline-offset"), s).toBe("-3px");
    }
    // The console's captures sit in no scroller, so their links keep the ring 3px outside, as every other link does.
    expect(
      MODULE_RULES.filter((r) => r.file === "console" && r.decls["outline-offset"]).map(where),
    ).toEqual([]);
    // Scrollers with links at their edges (the Canary tables) leave 6px of
    // room each side for the 2px ring, 3px out, and take it back with their margin.
    expect(read("src", "components", "site", "ScrollRegion.tsx")).toContain(
      'target.scrollIntoView({ block: "nearest", inline: "nearest" })',
    );
    for (const [file, selector] of [["canary", ".scroll"]] as const) {
      expect(decl(file, selector, "padding-inline"), selector).toBe("6px");
      expect(decl(file, selector, "margin-inline"), selector).toBe("-6px");
      // ScrollRegion scrolls a link that a keyboard focuses into view; it stops 6px in, so its ring shows whole.
      expect(decl(file, selector, "scroll-padding-inline"), selector).toBe("6px");
    }
  });

  it("keeps states and marks visible in forced colours (Windows contrast themes)", () => {
    const inForced = (file: string, selector: string) =>
      RULES.filter((r) => r.file === file && forced(r) && r.selectors.includes(selector)).map(
        (r) => r.decls,
      );
    expect(inForced("site", '.scenario[aria-pressed="true"]')[0]?.["border-color"]).toBe(
      "Highlight",
    );
    expect(decl("site", '.scenario[aria-pressed="true"]', "border-width")).toBe("2px");
    for (const s of [".netPillCurrent", ".pill", ".state", ".payeeLock"]) {
      expect(inForced("site", s)[0]?.border, s).toBe("1px solid CanvasText");
    }
    expect(inForced("site", ".gold")[0]?.color).toBe("CanvasText");
    expect(inForced("docs", ".gold")[0]?.color).toBe("CanvasText");
    expect(inForced("docs", ".chipDot")[0]?.background).toBe("CanvasText");
  });

  it("declares one light scheme and asks browsers not to darken it on their own", () => {
    const root = RULES.find((r) => r.file === "globals" && r.selectors.includes(":root"));
    expect(root?.decls["color-scheme"]).toBe("only light");
    expect(read("src", "app", "layout.tsx")).toContain(
      'export const viewport: Viewport = { colorScheme: "only light" };',
    );
    // There is no dark theme yet: no rule answers prefers-color-scheme, so nothing is styled for a scheme never checked.
    expect(RULES.some((r) => r.at.some((a) => a.includes("prefers-color-scheme")))).toBe(false);
  });

  it("keeps diff fences out of the docs: the code theme's diff colours carry their own fills, under 4.5:1", () => {
    const content = walk(join(WEB, "content")).filter((f) => /\.mdx?$/.test(f));
    expect(content.length).toBeGreaterThan(10);
    const found = content.filter((f) => /^\s*```diff\b/m.test(readFileSync(f, "utf8")));
    expect(found.map((f) => toPosix(relative(WEB, f)))).toEqual([]);
  });
});
