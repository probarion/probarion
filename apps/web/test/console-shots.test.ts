// The console's screenshots: real testnet captures of the demo vault, taken while INV-2004 went through it. The landing
// shows one, the invoice's page, in the use cases (#integrate), at its own 856px and never larger; the held and the
// paid shot are in the docs. What they share (testnet, the day they were taken, the vault) is one record. The files'
// sizes are read from their headers, so the page never stretches an image it does not have. Nothing scrolls sideways.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import c from "@/components/site/console.module.css";
import site from "@/components/site/site.module.css";
import { explorerTxUrl } from "@/lib/config";
import { CONSOLE_ROUTE, CONSOLE_SHOTS } from "@/lib/site/facts";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "..", "..");
const demo = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/testnet.json"), "utf8"))
  .demo_vault as { account: string; payee: string; approvers: string[] };

const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

/** A lossy WebP's canvas size: the VP8 frame header after its start code 9d 01 2a. */
function webpSize(bytes: Buffer) {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WEBP");
  expect(bytes.toString("ascii", 12, 16)).toBe("VP8 ");
  expect([...bytes.subarray(23, 26)]).toEqual([0x9d, 0x01, 0x2a]);
  return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
}

const shot = (id: string) => {
  const found = CONSOLE_SHOTS.shots.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no shot ${id}`);
  return found;
};
const recorded = (term: string) => CONSOLE_SHOTS.record.find((r) => r.term === term)?.value;

const HTML = renderToStaticMarkup(createElement(Home));

/** The use cases of the rendered landing, from their <section> to the mainnet section's. */
function section() {
  const start = HTML.indexOf('id="integrate"');
  const end = HTML.indexOf('id="mainnet"');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return HTML.slice(start, end);
}

describe("the console screenshots", () => {
  it("says once, in the record, that every shot is of the testnet demo vault on 2026-11-09", () => {
    expect(CONSOLE_SHOTS.shots.map((s) => s.id)).toEqual(["held", "invoice", "paid"]);
    expect(CONSOLE_SHOTS.record).toEqual([
      { term: "Network", value: "Testnet" },
      { term: "Captured", value: "2026-11-09" },
      { term: "Vault", value: `\`${demo.account}\`` },
    ]);
    // No shot repeats it under itself.
    for (const s of CONSOLE_SHOTS.shots) expect(Object.keys(s)).not.toContain("meta");
  });

  it("serves each image from public/ at the size the page gives it, outside the console's paths", () => {
    for (const s of CONSOLE_SHOTS.shots) {
      expect(s.src).toMatch(/^\/shots\/console-[a-z]+\.webp$/);
      // The proxy sends every /console path without a session to sign in, images included.
      expect(s.src.startsWith(`${CONSOLE_ROUTE}/`)).toBe(false);
      const size = webpSize(readFileSync(join(WEB, "public", s.src)));
      expect(size).toEqual({ width: s.width, height: s.height });
      expect(s.alt.length).toBeGreaterThan(40);
    }
    // The landing's shot is the 856px capture: the frame and `sizes` below hold the page to it.
    expect(shot(CONSOLE_SHOTS.landing.shot)).toMatchObject({
      src: "/shots/console-invoice.webp",
      width: 856,
      height: 430,
    });
  });

  it("links the held spend and its approval to their testnet transactions, and gives the invoice's page none", () => {
    const held = "9qUtxTguj17dp8KX61GW7YTVBQyJGZBt1ZWiQoM2699d";
    const approved = "EYPyrd9hapyZthjMwysShUnkDSVkMQHtPYHitidbr972";
    expect(shot("held").link).toEqual({
      label: "Held 9qUtxTgu…699d",
      url: explorerTxUrl("testnet", held),
    });
    expect(shot("paid").link).toEqual({
      label: "Approved EYPyrd9h…r972",
      url: explorerTxUrl("testnet", approved),
    });
    expect(shot("invoice").link).toBeUndefined();
    expect(CONSOLE_SHOTS.txLabel).toBe("Testnet transaction");
  });

  it("says the approver approved from their own key, as on 2026-11-09, the day of the shots", () => {
    // Approving in the console was first tried on 2026-11-11, on another vault: these shots show the demo vault,
    // whose approver approved with near-cli.
    expect(recorded("Captured")).toBe("2026-11-09");
    expect(shot("paid").body).toContain("from their own key");
    for (const s of CONSOLE_SHOTS.shots) {
      expect(`${s.title} ${s.body} ${s.alt}`).not.toMatch(/approved in the console/i);
    }
    expect(shot("held").body).toContain(`\`${demo.payee}\``);
    expect(demo.approvers).toEqual(["probarion-approver.testnet"]);
  });

  it("shows one shot on the landing, the invoice's page, in the use cases after the uses and before the ways in", () => {
    const part = section();
    const s = shot(CONSOLE_SHOTS.landing.shot);
    expect(CONSOLE_SHOTS.landing).toEqual({ shot: "invoice", eyebrow: "In the console" });
    // One figure, inside #integrate: the console no longer has a section of its own.
    expect(HTML.split(`<figure class="${c.figure}">`).length - 1).toBe(1);
    expect(part.split(`<figure class="${c.figure}">`).length - 1).toBe(1);
    expect(HTML).not.toContain('id="console"');
    for (const other of CONSOLE_SHOTS.shots.filter((x) => x.id !== s.id)) {
      expect(HTML, other.id).not.toContain(encodeURIComponent(other.src));
      expect(HTML, other.id).not.toContain(`href="${other.src}"`);
    }
    expect(part.indexOf('id="integrate-uses"')).toBeLessThan(part.indexOf("<figure"));
    expect(part.indexOf("</figure>")).toBeLessThan(part.indexOf(">Four ways in</h3>"));
    // The capture in its frame, named by its alt text, at its own size.
    const figure = part.slice(part.indexOf("<figure"), part.indexOf("</figure>"));
    expect(figure).toContain(`<div class="${c.frame}"><img alt="${s.alt.replace(/'/g, "&#x27;")}"`);
    expect(decode(figure)).toContain(`alt="${s.alt}"`);
    expect(figure).toContain(`width="${s.width}"`);
    expect(figure).toContain(`height="${s.height}"`);
    expect(figure).toContain(encodeURIComponent(s.src));
    // `sizes` asks for the 856px file wherever the frame has room for it, not the ~420px variant; the section is too
    // far down the page to load it first.
    expect(figure).toContain('sizes="(min-width: 900px) 856px, 100vw"');
    expect(figure).toContain('loading="lazy"');
    expect(figure).not.toMatch(/fetchPriority|rel="preload"/i);
    // The caption: the label, what the shot shows, the record it was taken under, the file and the console.
    const cap = figure.slice(figure.indexOf(`<figcaption class="${c.cap}">`));
    expect(cap).toContain(`<p class="${site.eyebrow}">${CONSOLE_SHOTS.landing.eyebrow}</p>`);
    expect(text(cap)).toContain(`${s.title} ${s.body}`);
    expect(cap).toContain(`<dl class="${c.record}">`);
    expect(text(cap)).toContain(`Network Testnet Captured 2026-11-09 Vault ${demo.account}`);
    expect(cap).toContain(`<dd><code>${demo.account}</code></dd>`);
    expect(cap).toContain(
      `href="${s.src}">${CONSOLE_SHOTS.fullSize}<span class="sr-only">: ${s.title.replace(/'/g, "&#x27;")}</span></a>`,
    );
    expect(cap).toMatch(
      new RegExp(
        `<a class="${site.link} ${c.link}" href="${CONSOLE_ROUTE}">${CONSOLE_SHOTS.open.label} <span aria-hidden="true">→</span></a>`,
      ),
    );
    expect(CONSOLE_SHOTS.open).toEqual({ label: "Open console", href: CONSOLE_ROUTE });
    // Nothing joins a link to a line of metadata, and the file opens in this tab.
    expect(text(figure)).not.toContain("·");
    expect(figure).not.toContain('target="_blank"');
  });

  it("frames the capture at no more than its file's width, and scrolls nothing sideways", () => {
    const css = readFileSync(join(WEB, "src/components/site/console.module.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(css).not.toMatch(/overflow(-x)?:\s*(auto|scroll)/);
    expect(css).not.toMatch(/scroll-snap/);
    expect(css).not.toMatch(/cursor:\s*zoom-in/);
    // 856px of capture plus 10px of padding and a 1px hairline each side; the image fills it and keeps its ratio.
    expect(css).toMatch(
      /\.frame \{[^}]*max-width: 878px;[^}]*padding: 10px;[^}]*border: 1px solid var\(--color-line\);[^}]*border-radius: 24px;/,
    );
    expect(css).toMatch(/\.frame img \{[^}]*width: 100%;[^}]*height: auto;/);
    // Beside the caption from 1100px, the column is the frame's own width at most.
    expect(css).toMatch(/grid-template-columns: minmax\(0, 878px\) minmax\(17rem, 1fr\);/);
    // The vault in the record reads at the page's 13px floor for mono.
    expect(css).toMatch(/\.record dd code \{[^}]*font-size: 13px;/);
    const tsx = readFileSync(join(WEB, "src/components/site/ConsoleShots.tsx"), "utf8");
    expect(tsx).not.toContain("ScrollRegion");
    expect(tsx).toContain('sizes="(min-width: 900px) 856px, 100vw"');
  });
});
