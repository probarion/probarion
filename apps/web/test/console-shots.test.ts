// The landing's console screenshots (audit P1-23): real testnet captures of the demo vault, right after the ink band,
// as three numbered rows. What the three share (testnet, the day they were taken, the vault) is said once, in the
// section's head; each capture links to its file, and the held and the paid one to their testnet transactions. The
// files' sizes are read from their headers, so the page never stretches an image it does not have. Nothing in the
// section scrolls sideways.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import c from "@/components/site/console.module.css";
import h from "@/components/site/head.module.css";
import p from "@/components/site/parts.module.css";
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

/** The console section of the rendered landing, from its <section> to the ledger test's. */
function section() {
  const html = renderToStaticMarkup(createElement(Home));
  const band = html.indexOf('id="payee"');
  const mainnet = html.indexOf('id="mainnet"');
  const start = html.indexOf('id="console"');
  const verify = html.indexOf('id="verify"');
  expect(band).toBeGreaterThan(0);
  // The mainnet payouts sit higher, under the live check; the screenshots follow the ink band.
  expect(mainnet).toBeGreaterThan(0);
  expect(mainnet).toBeLessThan(band);
  expect(start).toBeGreaterThan(band);
  expect(verify).toBeGreaterThan(start);
  return html.slice(start, verify);
}

describe("the console screenshots on the landing (audit P1-23)", () => {
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

  it("sits right after the ink band: the head with its record, three numbered shots, and the proof and console links", () => {
    const part = section();
    const words = text(part);
    // The label is the eyebrow, over the heading that says what the screenshots show.
    expect(CONSOLE_SHOTS.eyebrow).toBe("The console");
    expect(words).toContain(`${CONSOLE_SHOTS.eyebrow} ${CONSOLE_SHOTS.title}`);
    // The lede as one run of text: its identifiers are kept whole in spans of their own (bits.tsx KeepRich).
    expect(decode(part.replace(/<[^>]+>/g, ""))).toContain(CONSOLE_SHOTS.intro.replace(/`/g, ""));
    // The record is in the head, under the lede: the page's one record of terms (parts.tsx TermRecord).
    const head = part.slice(part.indexOf(`<header class="${h.head}">`), part.indexOf("</header>"));
    expect(head).toContain(`<dl class="${p.record}">`);
    expect(head.indexOf(`class="${p.record}"`)).toBeGreaterThan(head.indexOf(`class="${h.lede}"`));
    expect(text(head)).toContain(`Network Testnet Captured 2026-11-09 Vault ${demo.account}`);
    expect(head).toContain(`<code>${demo.account}</code>`);
    // Three steps in one list, each a figure that opens with its caption; the numbers are the journey's (parts.module.css).
    expect(part).toContain(`<ol class="${c.steps}" role="list">`);
    expect(part.split(`<li class="${c.step}">`).length - 1).toBe(3);
    for (const [i, s] of CONSOLE_SHOTS.shots.entries()) {
      expect(part).toContain(
        `<figure class="${c.row}"><figcaption class="${c.cap}"><div class="${p.stepN}" aria-hidden="true">${i + 1}</div>`,
      );
      expect(words).toContain(`Step ${i + 1}: ${s.title}`);
      expect(decode(part)).toContain(`alt="${s.alt}"`);
      expect(part).toContain(encodeURIComponent(s.src));
      expect(part).toContain(`width="${s.width}"`);
      expect(part).toContain(`href="${s.src}"`);
      if (s.link !== undefined) expect(decode(part)).toContain(`href="${s.link.url}"`);
    }
    // The 856px file is what a wide screen gets, and the section is too far down the page to load it first.
    expect(part).toContain('sizes="(max-width: 1099px) 100vw, 856px"');
    expect(part).not.toMatch(/fetchPriority|rel="preload"/i);
    // Each transaction, in its step's caption under the sentence: the page's one label, the verb, the short hash in
    // mono glued to the shared arrow, and the new-tab words.
    expect(CONSOLE_SHOTS.txLabel).toBe("Testnet transaction");
    const slot = `<p class="${c.tx}"><span class="${p.label}">${CONSOLE_SHOTS.txLabel}</span>`;
    expect(part.split(slot).length - 1).toBe(2);
    for (const s of CONSOLE_SHOTS.shots) {
      if (s.link === undefined) continue;
      const [verb, hash] = s.link.label.split(" ");
      // The link sits in its own step's caption, after the step's title.
      const at = part.indexOf(`href="${s.link.url}"`);
      const own = part.slice(part.lastIndexOf(`<figcaption class="${c.cap}">`, at), at);
      expect(own, s.id).toContain(s.title);
      expect(own, s.id).not.toContain("</figcaption>");
      expect(part).toContain(
        `>${verb} <span class="${p.glue}"><span class="${p.hash}">${hash}</span><span class="${p.ext}" aria-hidden="true">↗</span></span><span class="sr-only"> (opens in a new tab)</span></a>`,
      );
    }
    // Below 924px each capture's own link names the step it opens, so three links never share one name (2.4.9).
    for (const s of CONSOLE_SHOTS.shots) {
      expect(decode(part)).toContain(
        `${CONSOLE_SHOTS.fullSize}<span class="sr-only">: ${s.title}</span></a>`,
      );
    }
    // Nothing joins a link to a line of metadata.
    expect(words).not.toContain("·");
    // The close: the proof page as the journey's button, the console as this section's solid one.
    expect(part).toContain(`href="${CONSOLE_SHOTS.proof.href}"`);
    expect(CONSOLE_SHOTS.proof.href).toBe(`/proof/${demo.account}`);
    expect(words).toContain(`${CONSOLE_SHOTS.proof.text} ${CONSOLE_SHOTS.proof.label} →`);
    expect(part).toContain(`href="${CONSOLE_ROUTE}"`);
  });

  it("scrolls nothing sideways, and keeps a transaction link and an account name each on one line", () => {
    const css = readFileSync(join(WEB, "src/components/site/console.module.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(css).not.toMatch(/overflow(-x)?:\s*(auto|scroll)/);
    expect(css).not.toMatch(/scroll-snap/);
    expect(css).not.toMatch(/cursor:\s*zoom-in/);
    // A transaction's hash and its arrow never break apart: the shared glue (parts.module.css), through Away's tx.
    const parts = readFileSync(join(WEB, "src/components/site/parts.module.css"), "utf8");
    expect(parts).toMatch(/\.glue,\s*\.keep \{[^}]*white-space: nowrap;/);
    expect(readFileSync(join(WEB, "src/components/site/ConsoleShots.tsx"), "utf8")).toContain(
      "<Away href={shot.link.url} tx={shot.link.label} />",
    );
    expect(css).toMatch(/\.cap p code \{[^}]*white-space: nowrap;/);
    // A capture is never drawn wider than its file: 856px plus its 1px border each side.
    expect(css).toMatch(/\.shot \{[^}]*max-width: 858px;/);
    const tsx = readFileSync(join(WEB, "src/components/site/ConsoleShots.tsx"), "utf8");
    expect(tsx).not.toContain("ScrollRegion");
  });
});
