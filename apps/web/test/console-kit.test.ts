import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buttonClass,
  dangerButtonClass,
  dangerLineButtonClass,
  inputClass,
  lineButtonClass,
  TONE_CLASSES,
} from "@/components/ui";
import { isTestFile, toPosix, walk } from "./deploy-scan";

// The console kit (site audit P1-21) uses the brand's colour tokens, and every pair it puts text on reads at WCAG AAA:
// 7:1 for normal text (1.4.6), which also covers the 4.5:1 that large text needs.
const AAA = 7;
const src = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");

/** The `--color-*` tokens of app/globals.css, as hex. */
const TOKENS = Object.fromEntries(
  [...src("app/globals.css").matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [
    m[1],
    m[2],
  ]),
) as Record<string, string>;
const WHITE = "#ffffff";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
/** `fg` at `alpha` over `bg`, as the browser paints `text-ink/75`. */
function over(fg: string, alpha: number, bg: string): string {
  return `#${[1, 3, 5]
    .map((i) => {
      const [f, b] = [fg, bg].map((h) => Number.parseInt(h.slice(i, i + 2), 16));
      return Math.round((f ?? 0) * alpha + (b ?? 0) * (1 - alpha))
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}
/** The colour of a class list's first `bg-*`, `text-*` or `border-*` utility that names a token (`text-sm` does not); `text-white` is white. */
function colour(cls: string, prefix: "bg" | "text" | "border"): string {
  for (const m of cls.matchAll(new RegExp(`(?:^|\\s)${prefix}-([a-z-]+)(?=\\s|$)`, "g"))) {
    const name = m[1] ?? "";
    if (name === "white") return WHITE;
    const hex = TOKENS[name];
    if (hex) return hex;
  }
  throw new Error(`no ${prefix}- colour token in "${cls}"`);
}

describe("the console kit's colours", () => {
  it("reads the tokens it needs from globals.css", () => {
    for (const name of ["ink", "paper", "surface", "mute", "line", "ok", "bad", "wait", "plan"]) {
      expect(TOKENS[name], name).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("every tone's text reads on its own background at 7:1 or more (Notice and Badge)", () => {
    for (const [tone, cls] of Object.entries(TONE_CLASSES)) {
      expect(contrast(colour(cls, "text"), colour(cls, "bg")), tone).toBeGreaterThanOrEqual(AAA);
    }
  });

  it("every button's text reads at 7:1 or more, and the red outline's also on its hover tint", () => {
    expect(contrast(colour(buttonClass, "text"), colour(buttonClass, "bg"))).toBeGreaterThanOrEqual(
      AAA,
    );
    expect(
      contrast(colour(dangerButtonClass, "text"), colour(dangerButtonClass, "bg")),
    ).toBeGreaterThanOrEqual(AAA);
    // The outlines sit on a white card, and the danger one turns its pale tint on hover.
    expect(contrast(colour(lineButtonClass, "text"), WHITE)).toBeGreaterThanOrEqual(AAA);
    expect(contrast(colour(dangerLineButtonClass, "text"), WHITE)).toBeGreaterThanOrEqual(AAA);
    expect(
      contrast(colour(dangerLineButtonClass, "text"), TOKENS["bad-bg"] ?? ""),
    ).toBeGreaterThanOrEqual(AAA);
  });

  it("the console's other text colours read at 7:1 or more where they are used", () => {
    const pairs: [string, string, string][] = [
      ["mute", "surface", "a hint or a note on a card"],
      ["mute", "paper", "the header's account line, and a tab that is not open, on the page"],
      ["wait", "surface", "a hold that ends soon, on a card"],
      ["ok", "surface", "a status line that went through"],
      ["bad", "surface", "an error under a field or a button"],
      ["bad", "paper", "an error on the page"],
      ["ink", "surface", "body text and the open tab"],
    ];
    for (const [fg, bg, where] of pairs) {
      expect(contrast(TOKENS[fg] ?? "", TOKENS[bg] ?? ""), where).toBeGreaterThanOrEqual(AAA);
    }
  });

  it("small and body text keep a line at 1.5 times their size or more (WCAG 1.4.8)", () => {
    const css = src("app/globals.css");
    for (const size of ["xs", "sm"]) {
      const m = new RegExp(`--text-${size}--line-height:\\s*([0-9.]+);`).exec(css);
      expect(Number(m?.[1]), `text-${size}`).toBeGreaterThanOrEqual(1.5);
    }
  });

  it("an input's mute border reads at 3:1 or more on a card, as a field's edge must (WCAG 1.4.11)", () => {
    expect(contrast(colour(inputClass, "border"), WHITE)).toBeGreaterThanOrEqual(3);
  });
});

/** A Tailwind palette colour (stone-300, hover:bg-rose-700/80, border-b-amber-200…) or a hex in a class. */
const OLD_PALETTE =
  /\b(?:stone|rose|emerald|amber|sky|red|green|slate|gray|zinc|neutral|yellow|blue|orange|teal|cyan|indigo|violet|purple|pink|lime|fuchsia)-\d{2,3}\b|\[#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\]/g;

describe("the old palette pattern", () => {
  it("catches the forms the old kit used, with any prefix, side or opacity, and any hex", () => {
    for (const s of [
      "text-stone-500",
      "hover:bg-stone-100",
      "text-stone-500/80",
      "border-b-amber-200",
      "fill-rose-600",
      "from-sky-50",
      "bg-[#0B0B0C]",
      "text-[#fff]",
      "border-[#0b0b0c99]",
    ]) {
      expect(s.match(OLD_PALETTE), s).not.toBeNull();
    }
  });

  it("leaves the tokens alone", () => {
    expect(
      "bg-ok-bg text-wait border-line text-mute bg-ink/85 outline-gold-small".match(OLD_PALETTE),
    ).toBeNull();
  });
});

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const rel = (f: string) => toPosix(relative(SRC, f));
/** Every console page and component, the wallet buttons, the pending parts, the extension page, the dialog and the frame. */
function consoleFiles(): string[] {
  return [
    ...[
      "app/console",
      "components/console",
      "components/wallet",
      "components/pending",
      "components/extension",
    ].flatMap((d) => walk(join(SRC, d))),
    join(SRC, "app/extension/page.tsx"),
    join(SRC, "components/ConfirmDialog.tsx"),
    join(SRC, "components/site/Container.tsx"),
  ].filter((f) => f.endsWith(".tsx") && !isTestFile(f));
}

describe("the console uses the tokens, not the old palette", () => {
  it("ui.tsx, apart from the proof page's panel tones", () => {
    const ui = src("components/ui.tsx");
    const from = ui.indexOf("export const PANEL_TONES");
    const to = ui.indexOf("};", from);
    expect(from).toBeGreaterThan(-1);
    expect((ui.slice(0, from) + ui.slice(to)).match(OLD_PALETTE)).toBeNull();
  });

  it("every console page and component, the wallet buttons, the extension page, the dialog and the frame", () => {
    const files = consoleFiles();
    expect(files.map(rel)).toEqual(
      expect.arrayContaining([
        "app/console/[vault]/page.tsx",
        "components/wallet/TxButton.tsx",
        "components/console/VaultNav.tsx",
        "components/pending/busy-label.tsx",
      ]),
    );
    const found = files.flatMap((f) =>
      (readFileSync(f, "utf8").match(OLD_PALETTE) ?? []).map((m) => `${rel(f)}: ${m}`),
    );
    expect(found).toEqual([]);
  });
});

/** A text colour class with any variant (hover:text-ink) and opacity (text-ink/60). `text-sm` names no token. */
const TEXT_COLOUR = /(?<=^|[\s"'`:])text-([a-z]+(?:-[a-z]+)*)(?:\/(\d{1,3}))?(?=[\s"'`]|$)/g;
/** Light text, which sits on an ink or red button; the button test above holds it. */
const LIGHT_TEXT = new Set(["paper", "white", "band-fg"]);

describe("every text colour on a console page reads at 7:1 (WCAG AAA)", () => {
  it("catches a dark token, with any variant or opacity, and skips sizes and light text", () => {
    const names = (s: string) => [...s.matchAll(TEXT_COLOUR)].map((m) => m[0]);
    expect(names('className="mt-1 text-xs text-mute hover:text-ink"')).toEqual([
      "text-xs",
      "text-mute",
      "text-ink",
    ]);
    expect(names("const muted = `text-ink/60`;")).toEqual(["text-ink/60"]);
  });

  it("on the page (paper) and on a card (white), from the sign-in page to every vault page", () => {
    const files = [
      ...consoleFiles(),
      join(SRC, "app/login/page.tsx"),
      join(SRC, "components/ui.tsx"),
    ];
    const low: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(TEXT_COLOUR)) {
        const [cls, name = "", pct] = m;
        const hex = name === "white" ? WHITE : TOKENS[name];
        if (!hex || LIGHT_TEXT.has(name)) continue;
        const alpha = pct ? Number(pct) / 100 : 1;
        const worst = Math.min(
          ...[TOKENS.paper ?? "", WHITE].map((bg) => contrast(over(hex, alpha, bg), bg)),
        );
        if (worst < AAA) low.push(`${rel(f)}: ${cls} ${worst.toFixed(2)}:1`);
      }
    }
    expect([...new Set(low)]).toEqual([]);
  });
});

describe("the page frame", () => {
  it("is the header's: 1320px wide, with 16px gutters up to 620px and 24px above, so the console lines up with the logo", () => {
    const container = src("components/site/Container.tsx");
    expect(container).toContain("max-w-[1320px]");
    const cls = /className="([^"]*)"/.exec(container)?.[1]?.split(/\s+/) ?? [];
    expect(cls).toEqual(expect.arrayContaining(["px-4", "min-[621px]:px-6"]));
    expect(container).not.toContain("max-w-5xl");
    const site = src("components/site/site.module.css");
    expect(site).toMatch(/\.wrap \{[^}]*max-width: 1320px;[^}]*padding-left: max\(24px/);
    expect(site).toMatch(
      /@media \(max-width: 620px\) \{\s*\.wrap \{\s*padding-left: max\(16px[^}]*padding-right: max\(16px/,
    );
  });

  it("keeps the console's and the extension page's content to 1024px, left-aligned, so fields and lines do not run the frame's width", () => {
    for (const path of ["app/console/layout.tsx", "app/extension/page.tsx"]) {
      expect(src(path), path).toMatch(/<div className="max-w-5xl">/);
    }
  });
});
