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

// The console kit (site audit P1-21) uses the brand's colour tokens, and every pair it puts text on reads at WCAG AA.
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

  it("every tone's text reads on its own background at 4.5:1 or more", () => {
    for (const [tone, cls] of Object.entries(TONE_CLASSES)) {
      expect(contrast(colour(cls, "text"), colour(cls, "bg")), tone).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("every button's text reads at 4.5:1 or more, and the red outline's also on its hover tint", () => {
    expect(contrast(colour(buttonClass, "text"), colour(buttonClass, "bg"))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      contrast(colour(dangerButtonClass, "text"), colour(dangerButtonClass, "bg")),
    ).toBeGreaterThanOrEqual(4.5);
    // The outlines sit on a white card, and the danger one turns its pale tint on hover.
    expect(contrast(colour(lineButtonClass, "text"), WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colour(dangerLineButtonClass, "text"), WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(colour(dangerLineButtonClass, "text"), TOKENS["bad-bg"] ?? ""),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("the console's other text colours read at 4.5:1 or more where they are used", () => {
    const pairs: [string, string, string][] = [
      ["mute", "surface", "a hint or a note on a card"],
      ["mute", "paper", "a tab that is not open, on the page"],
      ["wait", "surface", "a hold that ends soon, on a card"],
      ["ok", "surface", "a status line that went through"],
      ["bad", "surface", "an error under a field or a button"],
      ["ink", "surface", "body text and the open tab"],
    ];
    for (const [fg, bg, where] of pairs) {
      expect(contrast(TOKENS[fg] ?? "", TOKENS[bg] ?? ""), where).toBeGreaterThanOrEqual(4.5);
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

describe("the console uses the tokens, not the old palette", () => {
  const SRC = fileURLToPath(new URL("../src/", import.meta.url));
  const rel = (f: string) => toPosix(relative(SRC, f));

  it("ui.tsx, apart from the proof page's panel tones", () => {
    const ui = src("components/ui.tsx");
    const from = ui.indexOf("export const PANEL_TONES");
    const to = ui.indexOf("};", from);
    expect(from).toBeGreaterThan(-1);
    expect((ui.slice(0, from) + ui.slice(to)).match(OLD_PALETTE)).toBeNull();
  });

  it("every console page and component, the wallet buttons, the extension page, the dialog and the frame", () => {
    const files = [
      ...["app/console", "components/console", "components/wallet", "components/extension"].flatMap(
        (d) => walk(join(SRC, d)),
      ),
      join(SRC, "app/extension/page.tsx"),
      join(SRC, "components/ConfirmDialog.tsx"),
      join(SRC, "components/site/Container.tsx"),
    ].filter((f) => f.endsWith(".tsx") && !isTestFile(f));
    expect(files.map(rel)).toEqual(
      expect.arrayContaining([
        "app/console/[vault]/page.tsx",
        "components/wallet/TxButton.tsx",
        "components/console/VaultNav.tsx",
      ]),
    );
    const found = files.flatMap((f) =>
      (readFileSync(f, "utf8").match(OLD_PALETTE) ?? []).map((m) => `${rel(f)}: ${m}`),
    );
    expect(found).toEqual([]);
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
