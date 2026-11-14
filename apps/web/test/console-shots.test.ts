// The console on the site: three real testnet captures of the demo vault, taken while INV-2004 went through it, are in
// the docs; the landing redraws one of them, the invoice's page, as a board in the use cases (#integrate), from the
// record, and links the capture itself. Every value on the board is held here to the demo vault's ledger of
// 2026-11-11 (entries 7, 8 and 9), its deployment record and the shots' transactions. The files' sizes are read from
// their headers, so the docs never stretch an image they do not have. Nothing scrolls sideways.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import c from "@/components/site/console.module.css";
import ig from "@/components/site/integrate.module.css";
import pm from "@/components/site/parts.module.css";
import site from "@/components/site/site.module.css";
import { explorerTxUrl } from "@/lib/config";
import { refFor } from "@/lib/payables/facts";
import { seqAnchorId } from "@/lib/proof/decisions";
import { CONSOLE_ROUTE, CONSOLE_SHOTS, DEMO_PROOF, INVOICE_BOARD } from "@/lib/site/facts";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "..", "..");
const demo = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/testnet.json"), "utf8"))
  .demo_vault as { account: string; owner: string; payee: string; approvers: string[] };
const EVIDENCE = join(ROOT, "docs", "evidence", "demo-vault");
const NB = " ";

type Rule = { id: string; outcome: string; detail: string };
type Entry = {
  body: {
    seq: number;
    kind: string;
    at: string;
    request_id: string;
    mandate_id: number;
    invoice_hash: string;
    amount: string;
    proposal: unknown;
    evidence: unknown;
    rules: Rule[];
    verdict: string | null;
    decided_by: string | null;
    contract: { tx_hash: string; spend_id: number; status: string } | null;
    refs: { decision_body_hash: string } | null;
  };
  body_hash: string;
};
const LEDGER = readFileSync(join(EVIDENCE, "ledger-2026-11-11.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Entry);
const entry = (seq: number) => {
  const found = LEDGER.find((e) => e.body.seq === seq);
  if (found === undefined) throw new Error(`no ledger entry ${seq}`);
  return found;
};

const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
/** Text as it reads: inline tags dropped, block tags a space between their words. */
const text = (html: string) =>
  decode(
    html.replace(/<\/?(?:span|code|a|svg|path|circle|wbr)\b[^>]*>/g, "").replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
const plain = (rich: string) => rich.replace(/`/g, "");

/** A lossy WebP's canvas size: the VP8 frame header after its start code 9d 01 2a. */
function webpSize(bytes: Buffer) {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WEBP");
  expect(bytes.toString("ascii", 12, 16)).toBe("VP8 ");
  expect([...bytes.subarray(23, 26)]).toEqual([0x9d, 0x01, 0x2a]);
  return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
}

/** A ledger time as the board writes it: the day and the minute, in UTC. */
const minute = (iso: string) => `${iso.slice(0, 10)}, ${iso.slice(11, 16)} UTC`;

const shot = (id: string) => {
  const found = CONSOLE_SHOTS.shots.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no shot ${id}`);
  return found;
};
const recorded = (term: string) => CONSOLE_SHOTS.record.find((r) => r.term === term)?.value;
const B = INVOICE_BOARD;
const row = (label: string) => {
  const found = B.rows.find((r) => r.label === label);
  if (found === undefined) throw new Error(`no row ${label}`);
  return found;
};

const HTML = renderToStaticMarkup(createElement(Home));

/** The use cases of the rendered landing, from their <section> to the mainnet section's. */
function section() {
  const start = HTML.indexOf('id="integrate"');
  const end = HTML.indexOf('id="mainnet"');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return HTML.slice(start, end);
}
/** The use cases' figure, the board and its caption. */
function figure() {
  const part = section();
  return part.slice(part.indexOf("<figure"), part.indexOf("</figure>") + "</figure>".length);
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

  it("serves each image from public/ at the size the docs give it, outside the console's paths", () => {
    for (const s of CONSOLE_SHOTS.shots) {
      expect(s.src).toMatch(/^\/shots\/console-[a-z]+\.webp$/);
      // The proxy sends every /console path without a session to sign in, images included.
      expect(s.src.startsWith(`${CONSOLE_ROUTE}/`)).toBe(false);
      const size = webpSize(readFileSync(join(WEB, "public", s.src)));
      expect(size).toEqual({ width: s.width, height: s.height });
      expect(s.alt.length).toBeGreaterThan(40);
    }
    // The landing links the invoice's page, the capture its board redraws.
    expect(shot(CONSOLE_SHOTS.landing.shot).src).toBe("/shots/console-invoice.webp");
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
    // The held spend is ledger entry 9's transaction. The approval is on chain only (no code writes an approver's
    // decision to the ledger), and the docs' Holds and approvals page links the same transaction.
    expect(entry(9).body.contract?.tx_hash).toBe(held);
    const docs = readFileSync(
      join(WEB, "content", "docs", "concepts", "holds-and-approvals.mdx"),
      "utf8",
    );
    expect(docs).toContain(`(${explorerTxUrl("testnet", approved)})`);
  });

  it("says the approver approved from their own key, as on 2026-11-09, the day of the shots", () => {
    // Approving in the console was first tried on 2026-11-11, on another vault: these shots show the demo vault,
    // whose approver approved with near-cli.
    expect(recorded("Captured")).toBe("2026-11-09");
    expect(shot("paid").body).toContain("from their own key");
    expect(row("Contract did").text).toContain("from their own key");
    for (const s of CONSOLE_SHOTS.shots) {
      expect(`${s.title} ${s.body} ${s.alt}`).not.toMatch(/approved in the console/i);
    }
    expect(B.rows.map((r) => r.text).join(" ")).not.toMatch(/approved in the console/i);
    expect(shot("held").body).toContain(`\`${demo.payee}\``);
    expect(demo.approvers).toEqual(["probarion-approver.testnet"]);
  });
});

describe("the landing's invoice board, held to the demo vault's record", () => {
  const e7 = entry(7).body;
  const e8 = entry(8).body;
  const e9 = entry(9).body;

  it("draws INV-2004 as the ledger, the deployment record and the evidence README record it", () => {
    // Entries 7 to 9 are one invoice, 4 test USDC under mandate 1.
    for (const e of [e7, e8, e9]) {
      expect(e.invoice_hash, `${e.seq}`).toBe(B.invoice.hash.value);
      expect(e.amount, `${e.seq}`).toBe("4000000");
      expect(e.mandate_id, `${e.seq}`).toBe(1);
    }
    expect((Number(e8.amount) / 1e6).toFixed(2)).toBe(B.invoice.total);
    expect(B.invoice.unit).toBe("test USDC");
    expect(B.invoice.hash).toEqual({
      term: "sha256",
      value: e8.invoice_hash,
      short: `${e8.invoice_hash.slice(0, 8)}…${e8.invoice_hash.slice(-4)}`,
    });
    // The console's name for it is its spend reference.
    expect(B.invoice.ref).toBe(refFor(e8.invoice_hash));
    expect(B.invoice.number).toBe("INV-2004");
    expect(B.invoice.file).toBe("invoice-INV-2004.txt");
    const readme = readFileSync(join(EVIDENCE, "README.md"), "utf8").replace(/\s+/g, " ");
    expect(readme).toContain("`invoice-INV-2004.txt` in the console");
    // The upload time is the console page's, in the screenshot the README cites; the first decision is that minute.
    expect(B.invoice.rows).toEqual([
      { term: "Payee", value: `\`${demo.payee}\`` },
      { term: "Purchase order", value: "PO-1001, mandate 1" },
      { term: "Uploaded", value: minute(e7.at) },
    ]);
    expect(readme).toContain(
      "[the screenshot](../../../apps/web/public/shots/console-invoice.webp) that the landing page links, shows it uploaded by the owner at 17:33 UTC and confirmed at 17:37 UTC",
    );
    expect(readme).toContain('Mandate 1, "Sample PO-1001"');
    // The owner's NEP-413 confirm: entry 8's rule names the vault's owner, at the minute of the decision.
    expect(B.confirm.owner).toBe(demo.owner);
    expect(B.confirm.short).toBe(`${demo.owner.slice(0, 8)}…${demo.owner.slice(-4)}`);
    expect(B.confirm.meta).toBe(`NEP-413 signature, ${minute(e8.at)}`);
    const confirmed = e8.rules.find((r) => r.id === "custom.owner_confirmed");
    expect(confirmed?.detail).toContain(`owner ${demo.owner} signed it (NEP-413`);
    expect(confirmed?.detail).toContain(
      `pay 4.000000 USDC (4000000 base units) to near:${demo.payee}`,
    );
  });

  it("lists the code's rules as entry 8 records them, every one passed, and its verdict", () => {
    expect(B.rules.list.map((r) => r.id)).toEqual(e8.rules.map((r) => r.id));
    expect(e8.rules).toHaveLength(15);
    for (const r of e8.rules) expect(r.outcome, r.id).toBe("pass");
    expect([e8.kind, e8.verdict, e8.decided_by]).toEqual(["decision", "allow", "rules-only"]);
    expect([e8.proposal, e8.evidence]).toEqual([null, null]);
    expect(B.rules.show).toBe(`Show the ${e8.rules.length} rules`);
    expect(B.rules.hide).toBe(`Hide the ${e8.rules.length} rules`);
    expect(row("Code allowed").text).toBe(
      `${e8.rules.length} rules passed, the owner's signature among them. The code allowed the payment.`,
    );
    // Each rule's numbers are its detail's: as written, in USDC (6 decimals), the expiry's day, or the mandate's id.
    for (const [i, r] of B.rules.list.entries()) {
      const detail = e8.rules[i]?.detail ?? "";
      const raw = detail.match(/\d+/g) ?? [];
      const known = new Set([
        String(e8.mandate_id),
        ...raw,
        ...raw.map((n) => String(Number(n) / 1e6)),
        // A time in nanoseconds: its first 13 digits are milliseconds.
        ...raw
          .filter((n) => n.length === 19)
          .map((n) => new Date(Number(n.slice(0, 13))).toISOString().slice(0, 10)),
      ]);
      for (const n of r.text.match(/\d{4}-\d{2}-\d{2}|\d+/g) ?? [])
        expect(known.has(n), `${r.id}: ${n} in "${detail}"`).toBe(true);
    }
  });

  it("tells what the model, the code and the contract did, each row as its entry has it", () => {
    expect(B.rows.map((r) => r.label)).toEqual(["Model wanted", "Code allowed", "Contract did"]);
    expect(B.rows.map((r) => r.stamps.map((x) => `${x.tone} ${x.label}`))).toEqual([
      ["none No model"],
      ["paid Allowed"],
      ["held Held", "paid Paid"],
    ]);
    // Entry 7: no model, so the code refused until the owner confirmed the amount.
    expect([e7.kind, e7.verdict, e7.decided_by, e7.proposal]).toEqual([
      "decision",
      "refuse",
      "rules-only",
      null,
    ]);
    const without = e7.rules.at(-1);
    expect(without?.id).toBe("custom.owner_confirms_without_model");
    expect(without?.outcome).toBe("refuse");
    expect(without?.detail).toContain(
      "no model read this invoice: nothing is sent; the owner confirms the amount",
    );
    expect(row("Model wanted").text.startsWith("No model read this invoice.")).toBe(true);
    // Each decision links its card on the proof page, which gives each decision id="seq-N".
    expect(row("Model wanted").entry).toEqual({
      seq: 7,
      label: "Ledger entry 7, on the proof page",
      href: `${DEMO_PROOF}#${seqAnchorId(7)}`,
    });
    expect(row("Code allowed").entry).toEqual({
      seq: 8,
      label: "Ledger entry 8, on the proof page",
      href: `${DEMO_PROOF}#${seqAnchorId(8)}`,
    });
    expect(DEMO_PROOF).toBe(`/proof/${demo.account}`);
    // Entry 9: the vault held spend 3 for entry 8's decision; the approver's transaction paid it.
    expect(e9.kind).toBe("payment");
    expect(e9.contract).toMatchObject({ spend_id: 3, status: "held" });
    expect(e9.refs?.decision_body_hash).toBe(entry(8).body_hash);
    expect(e9.request_id).toBe(e8.request_id);
    const did = row("Contract did");
    expect(did.text).toContain(`held it as spend ${e9.contract?.spend_id}.`);
    expect(did.text).toContain(`paid 4 test USDC to \`${demo.payee}\`.`);
    expect(did.text).toContain("above the 3 USDC approval limit");
    expect(did.txs).toEqual([shot("held").link, shot("paid").link]);
    expect(did.txs?.[0]?.url).toBe(explorerTxUrl("testnet", e9.contract?.tx_hash ?? ""));
    expect(did.entry).toBeUndefined();
    expect(CONSOLE_SHOTS.landing.board).toBe(B);
  });

  it("renders it in the use cases after the uses and before the ways in, with no image", () => {
    const part = section();
    const L = CONSOLE_SHOTS.landing;
    expect([L.shot, L.eyebrow, L.title]).toEqual([
      "invoice",
      "In the console",
      "What Probarion did with one invoice",
    ]);
    // One figure, inside #integrate: the console has no section of its own.
    const open = `<figure class="${c.figure}" aria-labelledby="integrate-invoice">`;
    expect(HTML.split(open).length - 1).toBe(1);
    expect(part.split(open).length - 1).toBe(1);
    expect(HTML).not.toContain('id="console"');
    expect(part.indexOf('id="integrate-uses"')).toBeLessThan(part.indexOf("<figure"));
    expect(part.indexOf("</figure>")).toBeLessThan(part.indexOf(">Four ways in</h3>"));
    // No image: the page loads no capture, and names the invoice's file once, as the screenshot link's target.
    const fig = figure();
    expect(fig).not.toContain("<img");
    expect(HTML).not.toMatch(/console-(held|invoice|paid)\.webp(?!")/);
    for (const s of CONSOLE_SHOTS.shots) {
      expect(HTML, s.id).not.toContain(encodeURIComponent(s.src));
      expect(HTML.split(s.src).length - 1, s.id).toBe(s.id === L.shot ? 1 : 0);
    }
    // The caption leads: the label, the title as the figure's name, the sentence, the record and the two links.
    expect(fig.startsWith(`${open}<figcaption class="${c.cap}">`)).toBe(true);
    const cap = fig.slice(0, fig.indexOf("</figcaption>"));
    expect(cap).toContain(`<p class="${site.eyebrow}">${L.eyebrow}</p>`);
    expect(cap).toContain(`<h3 class="${c.title}" id="integrate-invoice">${L.title}</h3>`);
    expect(text(cap)).toContain(`${L.eyebrow} ${L.title} ${L.body}`);
    expect(L.body).toBe(
      "INV-2004 went through Payables on testnet. It asked for 4 test USDC, above the mandate's 3 USDC approval limit. Each step links its proof.",
    );
    expect(cap).toContain(`<dl class="${c.record}">`);
    expect(text(cap)).toContain(`Network Testnet Captured 2026-11-09 Vault ${demo.account}`);
    expect(cap).toContain(`<dd><code>${demo.account}</code></dd>`);
    expect(L.shotLink).toEqual({
      label: "Open the screenshot",
      after: ": the invoice's page in the console",
    });
    expect(cap).toContain(
      `<a class="${site.link} ${c.link}" href="/shots/console-invoice.webp">Open the screenshot<span class="sr-only">: the invoice&#x27;s page in the console</span></a>`,
    );
    expect(cap).toContain(
      `<a class="${site.link} ${c.link}" href="${CONSOLE_ROUTE}">${CONSOLE_SHOTS.open.label}${NB}<span aria-hidden="true">→</span></a>`,
    );
    expect(CONSOLE_SHOTS.open).toEqual({ label: "Open console", href: CONSOLE_ROUTE });
    // Nothing joins a link to a line of metadata.
    expect(text(fig)).not.toMatch(/[·–—]/);
  });

  it("renders the invoice's sheet and the three rows from the facts, the rules in a closed fold", () => {
    const fig = figure();
    const board = fig.slice(fig.indexOf(`<div class="${c.board}">`));
    expect(board.length).toBeGreaterThan(1000);
    // The sheet: its number, file and reference, the total, the recorded fields and the owner's confirm.
    const sheet = board.slice(board.indexOf("<article"), board.indexOf("</article>"));
    expect(sheet).toMatch(/^<article class="[^"]+" aria-label="Invoice INV-2004">/);
    expect(text(sheet)).toBe(
      [
        "Invoice Testnet INV-2004",
        `${B.invoice.file} ${B.invoice.ref}`,
        "Total due 4.00 test USDC",
        `Payee ${demo.payee}`,
        "Purchase order PO-1001, mandate 1",
        `Uploaded ${minute(e7.at)}`,
        `sha256 ${B.invoice.hash.short}`,
        `Confirmed by the owner ${B.confirm.short} ${B.confirm.meta}`,
      ].join(" "),
    );
    expect(sheet).toContain(`<code title="${B.invoice.hash.value}">${B.invoice.hash.short}</code>`);
    expect(sheet).toContain(`<code title="${demo.owner}">${B.confirm.short}</code>`);
    // The rows: a heading and its stamps, the sentence, then its proof.
    const verdicts = board.slice(board.indexOf(`<div class="${c.verdicts}">`));
    const heads = [...verdicts.matchAll(/<h4 class="([^"]*)">([^<]*)<\/h4>/g)];
    expect(heads.map((h) => h[2])).toEqual(B.rows.map((r) => r.label));
    for (const h of heads) expect(h[1]).toBe(pm.label);
    const tone = { paid: ig.stampPaid, held: ig.stampHeld, none: ig.stampNone } as const;
    for (const r of B.rows) {
      for (const x of r.stamps) {
        expect(verdicts, x.label).toMatch(
          new RegExp(
            `<span class="${ig.stamp} ${tone[x.tone]}"><svg class="${pm.mark}"[^>]*>[\\s\\S]*?</svg>${x.label}<span class="sr-only">.</span></span>`,
          ),
        );
      }
      expect(text(verdicts), r.label).toContain(plain(r.text));
    }
    // The proof: the decisions on this site, in this tab; the transactions on the explorer, in a new one (parts Away).
    for (const r of B.rows) {
      if (r.entry === undefined) continue;
      expect(verdicts).toContain(
        `<a class="${site.link} ${c.vlink}" href="${r.entry.href}">${r.entry.label}${NB}<span aria-hidden="true">→</span></a>`,
      );
    }
    const away = [...verdicts.matchAll(/<a [^>]*href="(https:[^"]+)"[^>]*>/g)];
    expect(away.map((a) => a[1])).toEqual([shot("held").link?.url, shot("paid").link?.url]);
    for (const [a] of away) expect(a).toContain('target="_blank" rel="noreferrer"');
    const home = [...fig.matchAll(/<a [^>]*href="[/#][^"]*"[^>]*>/g)];
    expect(home).toHaveLength(4);
    for (const [a] of home) expect(a).not.toContain("target=");
    // The rules: a closed native details, its summary saying what it does, each rule passed in entry 8's order.
    expect(verdicts.split("<details").length - 1).toBe(1);
    expect(verdicts).toContain(`<details class="${c.rules}"><summary class="${c.rulesSummary}">`);
    expect(verdicts).not.toMatch(/<details[^>]* open/);
    expect(verdicts).toContain(
      `<span class="${c.whenShut}">${B.rules.show}</span><span class="${c.whenOpen}">${B.rules.hide}</span>`,
    );
    const list = verdicts.slice(verdicts.indexOf(`<ol class="${c.ruleList}" role="list">`));
    const ids = [
      ...list.matchAll(/<code>([a-z_.]+)<\/code><span class="sr-only">, passed:<\/span>/g),
    ];
    expect(ids.map((m) => m[1])).toEqual(e8.rules.map((r) => r.id));
    expect(list.split(`<li class="${pm.outPaid}">`).length - 1).toBe(15);
    expect(text(list)).toContain(
      B.rules.list.map((r) => `${r.id}, passed: ${plain(r.text)}`).join(" "),
    );
  });

  it("styles it with tokens, no image and no script, and scrolls nothing sideways", () => {
    const css = readFileSync(join(WEB, "src/components/site/console.module.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(css).not.toMatch(/overflow(-x)?:\s*(auto|scroll)/);
    expect(css).not.toMatch(/scroll-snap/);
    expect(css).not.toMatch(/\b(animation|transition)\s*:/);
    expect(css).not.toMatch(/prefers-color-scheme/);
    // Every colour is a token: no hex, rgb or hsl of its own.
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
    for (const v of css.match(/var\(--[a-z-]+\)/g) ?? [])
      expect(v).toMatch(/^var\(--(color|space|container)-[a-z-]+\)$/);
    // The board splits 5 to 7 from 900px; below, the sheet sits over the rows.
    expect(css).toMatch(
      /@media \(min-width: 900px\) \{[\s\S]*?\.board \{\s*grid-template-columns: minmax\(0, 5fr\) minmax\(0, 7fr\);/,
    );
    expect(css).toMatch(/\.board \{[^}]*border-radius: 24px;[^}]*overflow: hidden;/);
    // Mono text reads at the page's 13px floor, where .site code's 0.86em would set it smaller: each code in a 14px
    // line has a rule that sets 13px.
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selectors: (m[1] ?? "").split(",").map((x) => x.trim()),
      body: m[2] ?? "",
    }));
    for (const sel of [
      ".record dd code",
      ".sheet .invIds code",
      ".rows dd code",
      ".sig .sigWho code",
      ".ruleList li code",
    ]) {
      const set = rules.filter((r) => r.selectors.includes(sel));
      expect(
        set.map((r) => r.body.trim()),
        sel,
      ).toEqual(["font-size: 13px;"]);
    }
    // The summary and each link are 44px tap targets: 22.5px of line and 11px above and below, or 10px and a border.
    expect(css).toMatch(
      /\.link \{\s*padding-block: 11px;\s*font-size: 15px;[^}]*line-height: 1\.5;/,
    );
    expect(css).toMatch(
      /\.vlink \{\s*padding-block: 11px;[^}]*font-size: 15px;[^}]*line-height: 1\.5;/,
    );
    expect(css).toMatch(
      /\.rulesSummary \{[^}]*padding: 10px 16px;\s*border: 1px solid var\(--color-line\);[^}]*font-size: 15px;[^}]*line-height: 1\.5;/,
    );
    const tsx = readFileSync(join(WEB, "src/components/site/ConsoleShots.tsx"), "utf8");
    expect(tsx).not.toContain("next/image");
    expect(tsx).not.toContain('"use client"');
    expect(tsx).not.toContain("ScrollRegion");
    // The stamps' new tones are the page's pairs too.
    const integrate = readFileSync(join(WEB, "src/components/site/integrate.module.css"), "utf8");
    expect(integrate).toMatch(
      /\n\.stampHeld \{\n {2}background: var\(--color-wait-bg\);\n {2}color: var\(--color-wait\);\n\}/,
    );
    expect(integrate).toMatch(
      /\n\.stampNone \{\n {2}background: var\(--color-plan-bg\);\n {2}color: var\(--color-plan\);\n\}/,
    );
  });
});
