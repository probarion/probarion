// The landing's console screenshots (audit P1-23): real testnet captures of the demo vault, each captioned with the
// network, the date and the vault, in a strip right after the ink band. The files' sizes are read from their headers,
// so the page never stretches an image it does not have.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import { explorerTxUrl } from "@/lib/config";
import { CONSOLE_ROUTE, CONSOLE_SHOTS } from "@/lib/site/facts";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "..", "..");
const demo = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/testnet.json"), "utf8"))
  .demo_vault as { account: string; payee: string; approvers: string[] };

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

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

describe("the console screenshots on the landing (audit P1-23)", () => {
  it("captions every shot with testnet, the date and the demo vault", () => {
    expect(CONSOLE_SHOTS.shots.map((s) => s.id)).toEqual(["held", "invoice", "paid"]);
    for (const s of CONSOLE_SHOTS.shots) {
      expect(s.meta).toBe(`Testnet console, 2026-11-09, vault ${demo.account}`);
      expect(s.meta).toContain("testnet");
    }
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
  });

  it("links the held spend and its approval to their testnet transactions", () => {
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
  });

  it("says the approver approved from their own key, as on 2026-11-09, the day of the shots", () => {
    // Approving in the console was first tried on 2026-11-11, on another vault: these shots show the demo vault,
    // whose approver approved with near-cli.
    for (const s of CONSOLE_SHOTS.shots) expect(s.meta).toContain("2026-11-09");
    expect(shot("paid").body).toContain("from their own key");
    for (const s of CONSOLE_SHOTS.shots) {
      expect(`${s.title} ${s.body} ${s.alt}`).not.toMatch(/approved in the console/i);
    }
    expect(shot("held").body).toContain(`\`${demo.payee}\``);
    expect(demo.approvers).toEqual(["probarion-approver.testnet"]);
  });

  it("sits right after the ink band, with each shot, its caption and the proof and console links", () => {
    const html = renderToStaticMarkup(createElement(Home));
    const band = html.indexOf('id="payee"');
    const mainnet = html.indexOf('id="mainnet"');
    const start = html.indexOf('id="console"');
    const verify = html.indexOf('id="verify"');
    expect(band).toBeGreaterThan(0);
    // The mainnet payout sits between the ink band and the screenshots.
    expect(mainnet).toBeGreaterThan(band);
    expect(start).toBeGreaterThan(mainnet);
    expect(verify).toBeGreaterThan(start);
    const section = html.slice(start, verify);
    const words = text(section);
    expect(words).toContain(CONSOLE_SHOTS.title);
    expect(words).toContain(text(CONSOLE_SHOTS.intro.replace(/`/g, "")));
    for (const s of CONSOLE_SHOTS.shots) {
      expect(words).toContain(s.title);
      expect(words).toContain(s.meta);
      expect(decode(section)).toContain(`alt="${s.alt}"`);
      expect(section).toContain(encodeURIComponent(s.src));
      expect(section).toContain(`width="${s.width}"`);
      expect(section).toContain(`href="${s.src}"`);
      if (s.link !== undefined) expect(decode(section)).toContain(`href="${s.link.url}"`);
    }
    expect(section).toContain(`href="${CONSOLE_SHOTS.proof.href}"`);
    expect(CONSOLE_SHOTS.proof.href).toBe(`/proof/${demo.account}`);
    expect(section).toContain(`href="${CONSOLE_ROUTE}"`);
  });

  it("scrolls sideways on a phone, and keeps a link's screen-reader text inside the row", () => {
    const css = readFileSync(join(WEB, "src/components/site/site.module.css"), "utf8");
    const rule = (from: string, name: string) => {
      const at = from.indexOf(`.${name} {`);
      expect(at, name).toBeGreaterThan(-1);
      return from.slice(at, from.indexOf("}", at));
    };
    // The caption links' "(opens in a new tab)" is absolutely positioned: with no positioned row to hold it, it
    // escapes the scrolling row and widens the page (734px at a 375px width).
    expect(rule(css, "shotRow")).toContain("position: relative");
    const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
    const row = rule(phone, "shotRow");
    expect(row).toContain("overflow-x: auto");
    expect(row).toContain("scroll-snap-type: x mandatory");
    expect(rule(phone, "shot")).toContain("scroll-snap-align: start");
    // A transaction link wraps as a whole, never inside its hash.
    expect(css).toMatch(/\.shotMeta a \{[^}]*white-space: nowrap;/);
  });
});
