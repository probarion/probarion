// The landing's status board (components/site/StatusBoard.tsx): every row stands on a status row, every mark is held to
// the words of the record that backs it, every evidence link to a named constant and its source, and the copy to the
// site's rules. Nothing here fetches: links are checked against the repository and the transactions it records.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import { StatusBoard } from "@/components/site/StatusBoard";
import b from "@/components/site/status.module.css";
import { REHEARSAL } from "@/lib/canary/rehearsal";
import { explorerTxUrl } from "@/lib/config";
import { PAGES, pageFile } from "@/lib/docs/registry";
import { REPO_URL } from "@/lib/proof/cli";
import {
  BASE_TX,
  BOARD_GROUPS,
  BOARD_LINKS,
  BOARD_TX,
  type BoardItem,
  type BoardPart,
  boardEntries,
  CONSOLE_ROUTE,
  DEMO_PROOF,
  EVIDENCE_KINDS,
  EVIDENCE_LABEL_MAX,
  HERO,
  INTEGRATE,
  LINKS,
  MAINNET_TX,
  type ProofMark,
  proofOfParts,
  proofSummary,
  REAL_MONEY_KINDS,
  RESULT_KINDS,
  STATUS,
  STATUS_AS_OF,
  STATUS_BOARD,
  STATUS_KEY,
  STORY,
  statusOf,
  TX,
  type TxFact,
  type UseMark,
} from "@/lib/site/facts";
import { linkProblem } from "./docs-helpers";

const WEB = fileURLToPath(new URL("..", import.meta.url));
/** INV-2001 on the testnet demo vault, the transaction the invoice story and the Payables row link. */
const DEMO_PAID_TX: TxFact = (() => {
  const [link] = STORY.invoices[0].evidence.tx as readonly { label: string; url: string }[];
  return {
    hash: link?.url.split("/").pop() ?? "?",
    label: link?.label ?? "?",
    url: link?.url ?? "?",
  };
})();
const ROOT = join(WEB, "..", "..");
const text = (...p: string[]) => readFileSync(join(...p), "utf8");
/** Whitespace folded, so a sentence a Markdown file wraps reads as one line. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const SOURCES = {
  readme: flat(text(ROOT, "README.md")),
  judges: flat(text(ROOT, "JUDGES.md")),
  works: flat(text(WEB, "content", "docs", "start", "what-works-today.mdx")),
  trial: flat(text(ROOT, "docs", "evidence", "trial-vault", "README.md")),
  demo: flat(text(ROOT, "docs", "evidence", "demo-vault", "README.md")),
} as const;
type Quote = readonly [keyof typeof SOURCES, string];

/** The board as the landing draws it: compact, a block of #verify. */
const board = () => renderToStaticMarkup(createElement(StatusBoard, { compact: true }));
/** The full board, a section of its own. */
const fullBoard = () => renderToStaticMarkup(createElement(StatusBoard));
const landing = () => renderToStaticMarkup(createElement(Home));
/** The text a visitor reads: inline tags join their words, block tags part them. */
const visibleText = (html: string) =>
  html
    .replace(/<\/?(?:a|code|span|strong|svg|path|circle|rect)\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const anchors = (html: string) => [...html.matchAll(/<a\s[^>]*>.*?<\/a>/g)].map((m) => m[0]);
const hrefOf = (a: string) => /\shref="([^"]*)"/.exec(a)?.[1] ?? "";
/** Every string of a value, wherever it sits. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
/** An en dash or an em dash (by code point, so that this file holds neither). */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const ITEMS: readonly BoardItem[] = BOARD_GROUPS.flatMap((g) => g.items);
const PARTS: readonly BoardPart[] = ITEMS.flatMap((i) => i.parts ?? []);
const ENTRIES = boardEntries();
const isItem = (e: BoardItem | BoardPart): e is BoardItem => "where" in e;

/**
 * What backs each mark, in the record's own words: the proof mark first (a real run, or what was not run), then the
 * use mark (deployed, or published). A row with no use mark has no use quote, and the test holds the two together.
 */
const BACKING: Readonly<Record<string, { proof: readonly Quote[]; use?: readonly Quote[] }>> = {
  "vault-contract": {
    proof: [["judges", "The contract enforces the mandate on testnet"]],
    use: [["readme", "**Shipped on NEAR testnet** as `v0.probarion.testnet`"]],
  },
  "mainnet-vault": {
    proof: [
      ["judges", "The contract enforces the mandate on mainnet"],
      ["judges", "| Payouts through NEAR Intents on mainnet |"],
      ["judges", "| A payment on an attested model's proposal on mainnet |"],
    ],
    use: [
      ["readme", "**Live on NEAR mainnet** since 2026-11-11, with real USDC and small amounts"],
    ],
  },
  "vault-factory": {
    proof: [
      [
        "demo",
        "`demo.vaults.probarion.testnet` is a vault created through the testnet factory from the web console",
      ],
    ],
    use: [["readme", "**Shipped on NEAR testnet** as `vaults.probarion.testnet` (2026-11-05)"]],
  },
  "reproducible-builds": {
    proof: [
      [
        "judges",
        "CI rebuilds both contracts in Docker with cargo-near 0.22.0 and compares their code hashes",
      ],
      ["readme", "| Reproducible builds and recorded code hashes | **Shipped** (CI, Docker) |"],
    ],
  },
  "offline-verifier": {
    proof: [["judges", "prints `9 passed, 0 failed, 0 unproven` and `RESULT: PASS`"]],
    use: [["readme", "**Shipped**, on npm as `@probarion/core` 0.1.1"]],
  },
  "sdk-and-cli": {
    proof: [["judges", "for the owner's own Base address with the SDK"]],
    use: [
      ["readme", "**Shipped**, on npm as `@probarion/sdk` 0.1.1"],
      ["readme", "**Shipped**, on npm as `probarion` 0.1.1"],
      ["readme", "with npm provenance"],
    ],
  },
  "mcp-server": {
    proof: [["readme", "**Shipped** and tested, and run by a real MCP client on NEAR testnet"]],
    use: [["readme", "It is on npm as `@probarion/mcp` 0.1.1"]],
  },
  "chrome-extension": {
    proof: [
      [
        "works",
        "No end-to-end run of it with a real wallet against this deployment is recorded yet",
      ],
    ],
    use: [["readme", "**Shipped** on the Chrome Web Store as version 0.1.0"]],
  },
  "web-console": {
    proof: [["trial", "### What the 2026-11-12 run does not show"]],
    use: [["readme", "Deployed at [probarion.xyz](https://probarion.xyz) on testnet, from `main`"]],
  },
  "web-console-set-up": {
    proof: [
      ["readme", "Sign-in and Create a vault have been tried there with a real wallet"],
      ["readme", "the Top-up tab's USDC transfer on NEAR, the Agent (MCP) tab"],
      ["readme", "added a spare agent key on the Keys tab and then removed it there"],
    ],
  },
  "web-console-money": {
    proof: [
      ["demo", "The testnet faucet mints 25 test USDC into the vault"],
      [
        "readme",
        "withdrew the vault's whole balance, 1 test USDC, with Withdraw all on the Overview",
      ],
    ],
  },
  "web-console-mandates": {
    proof: [
      ["readme", "the faucet, a mandate, four Payables invoices and a public proof page"],
      ["readme", "revoked a mandate on the Mandates tab"],
    ],
  },
  "web-console-payments": {
    proof: [
      ["readme", "approving two held spends on the console's approval page"],
      ["readme", "the owner rejected a held spend on the approval page"],
      ["readme", "Freeze and Unfreeze on the demo vault"],
    ],
  },
  // The alerts stand on the README's own row for them, not on the web-console row, whose text does not list them; the
  // proof page on the console's run of 2026-11-09.
  "web-console-alerts": {
    proof: [
      ["readme", "| Owner alerts by Telegram and email | **Built** and tested"],
      ["readme", "the bot sent real messages"],
      ["readme", "the faucet, a mandate, four Payables invoices and a public proof page"],
    ],
  },
  "web-console-not-tried": {
    proof: [
      ["readme", "No email has been sent yet."],
      ["readme", "is mainnet only and has not been tried with a live quote yet"],
      [
        "readme",
        "Its use on a phone is not confirmed: every step of both runs was in a desktop browser.",
      ],
      ["readme", "that run does not show the withholding or the Keys tab's ask"],
    ],
  },
  "public-proof-page": {
    proof: [["judges", "On 2026-11-12 all four passed on probarion.xyz"]],
    use: [["readme", "**Live** for the testnet demo vault `demo.vaults.probarion.testnet`"]],
  },
  "payables-agent": {
    proof: [["judges", "Payables paid two invoices on its own with an attested model"]],
    use: [["readme", "**Live on NEAR testnet**, deployed with the console at probarion.xyz"]],
  },
  canary: {
    proof: [["judges", "A gullible model's 50 USDC ask, refused on chain"]],
    use: [["readme", "**Live on NEAR testnet** since 2026-11-10, in live mode"]],
  },
  "attested-model-run": {
    proof: [
      ["judges", "A1 to A8, O1 and O2 on recorded decisions"],
      ["judges", "**The TEE measurement is not pinned**, so no check shows which model image ran"],
      [
        "judges",
        "On mainnet, the 3 of `v0.probarion.near` of 2026-11-13, entries 0, 1 and 4, pass A1 to A7",
      ],
      ["judges", "and O1 and O2 in a live run at 17:52 UTC on 2026-11-13"],
    ],
  },
};

describe("the status board's rows", () => {
  it("gives every status row one place on the board, under its own id, and nothing twice", () => {
    const html = board();
    for (const { id } of STATUS.rows) {
      expect(html.match(new RegExp(`\\sid="${id}"`, "g")), id).toHaveLength(1);
      expect(
        ENTRIES.some((e) => e.id === id),
        id,
      ).toBe(true);
    }
    const ids = ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Each entry says which status row it stands on; only the Chrome extension, a row the list leaves out, has none.
    const rows = new Set<string>(STATUS.rows.map((r) => r.id));
    for (const e of ENTRIES) {
      if (e.status === undefined) expect(e.id).toBe("chrome-extension");
      else expect(rows.has(e.status), e.id).toBe(true);
    }
    expect(new Set(ENTRIES.flatMap((e) => (e.status ? [e.status] : []))).size).toBe(
      STATUS.rows.length,
    );
  });

  it("marks each row by the tone of its status row: live is verified, work is in part or not tried yet", () => {
    for (const e of ENTRIES) {
      if (e.status === undefined) continue;
      const tone = STATUS.rows.find((r) => r.id === e.status)?.tone;
      if (isItem(e) && e.parts !== undefined) {
        // A row with parts takes its mark from them.
        expect(e.proof, e.id).toBe(proofOfParts(e.parts));
        continue;
      }
      const allowed: readonly ProofMark[] = tone === "live" ? ["verified"] : ["part", "untried"];
      expect(allowed, `${e.id}: ${tone}`).toContain(e.proof);
    }
    expect(proofOfParts(PARTS)).toBe("part");
    // The two "In part" rows: the console, through its untried part, and the model run, through its pill.
    expect(ITEMS.filter((i) => i.proof === "part").map((i) => i.id)).toEqual([
      "web-console",
      "attested-model-run",
    ]);
    expect(STATUS.rows.find((r) => r.id === "attested-model-run")?.pill).toContain(
      "image not pinned",
    );
  });

  it("keeps each status row's name, except the console's, whose parts carry the rest of its long name", () => {
    for (const i of ITEMS) {
      if (i.status === undefined || i.id === "web-console") continue;
      expect(i.name, i.id).toBe(STATUS.rows.find((r) => r.id === i.status)?.row);
    }
    expect(STATUS.rows.find((r) => r.id === "web-console")?.row.startsWith("Web console:")).toBe(
      true,
    );
  });

  it("holds every mark to the words of the record that backs it", () => {
    expect(Object.keys(BACKING).sort()).toEqual(ENTRIES.map((e) => e.id).sort());
    for (const e of ENTRIES) {
      const backing = BACKING[e.id];
      if (!backing) throw new Error(`no backing for ${e.id}`);
      expect(backing.proof.length, e.id).toBeGreaterThan(0);
      const use: UseMark | undefined = isItem(e) ? e.use : undefined;
      expect(backing.use === undefined, `${e.id}: a use mark has a use quote`).toBe(
        use === undefined,
      );
      for (const [source, words] of [...backing.proof, ...(backing.use ?? [])]) {
        expect(SOURCES[source], `${e.id}: ${words}`).toContain(flat(words));
      }
    }
    // Released means a package or a listing: every released row links npm, the MCP Registry or the store.
    for (const i of ITEMS.filter((x) => x.use === "released")) {
      expect(
        i.evidence.some((ev) => ["npm", "registry", "store"].includes(ev.kind)),
        i.id,
      ).toBe(true);
    }
  });

  it("lets only the Chrome extension stand outside the status list, held to the README and the docs", () => {
    const ext = ITEMS.find((i) => i.id === "chrome-extension");
    expect(ext?.status).toBeUndefined();
    expect(ext?.proof).toBe("untried");
    expect(ext?.use).toBe("released");
    expect(ext?.where.place).toBe("Chrome Web Store 0.1.0");
    expect(SOURCES.readme).toContain(
      "| Browser extension for Chrome | **Shipped** on the Chrome Web Store",
    );
    expect(ext?.evidence.map((e) => e.href)).toEqual([LINKS.chromeWebStore]);
  });

  it("opens with a summary computed from the board: how many rows are verified, and what each other row misses", () => {
    const summary = proofSummary();
    expect(summary.map((l) => l.mark)).toEqual(["verified", "part", "untried"]);
    for (const l of summary) {
      const rows = ITEMS.filter((i) => i.proof === l.mark);
      expect(l.count, l.mark).toBe(`${rows.length} of the ${ITEMS.length} rows`);
      expect(
        l.rows.map((r) => r.id),
        l.mark,
      ).toEqual(l.mark === "verified" ? [] : rows.map((i) => i.id));
    }
    expect(summary[0]?.count).toBe("10 of the 13 rows");
    // A row with parts names how many things they leave to try; any other row says what it misses in its own words.
    const left = PARTS.flatMap((p) => p.untried ?? []).length;
    expect(left).toBe(4);
    expect(summary.flatMap((l) => l.rows)).toEqual([
      { id: "web-console", name: "Web console", missing: `${left} things left to try` },
      {
        id: "attested-model-run",
        name: "Live attested model run",
        missing: "TEE image not pinned",
      },
      {
        id: "chrome-extension",
        name: "Chrome extension",
        missing: "no end-to-end run recorded yet",
      },
    ]);
    // Each of those words stands on the row's own Not yet line.
    expect(ITEMS.find((i) => i.id === "attested-model-run")?.limit).toContain(
      "The TEE measurement is not pinned",
    );
    expect(ITEMS.find((i) => i.id === "chrome-extension")?.limit).toContain(
      "No end-to-end run with a real wallet against this deployment is recorded yet",
    );
    for (const i of ITEMS) {
      expect(i.missing === undefined, i.id).toBe(
        i.proof === "verified" || (i.parts?.some((p) => p.untried !== undefined) ?? false),
      );
    }
    // On the page: above the key, at the top of the section, each named row linked to its place below.
    const html = board();
    const out = visibleText(html);
    expect(out).toContain("Verified: 10 of the 13 rows.");
    expect(out).toContain(
      "In part: Web console: 4 things left to try. Live attested model run: TEE image not pinned.",
    );
    expect(out).toContain("Not tried yet: Chrome extension: no end-to-end run recorded yet.");
    expect(out.indexOf("10 of the 13 rows")).toBeLessThan(
      out.indexOf(STATUS_KEY.proof.marks[0].means),
    );
    expect(html.indexOf(`aria-label="${STATUS_BOARD.summaryLabel}"`)).toBeLessThan(
      html.indexOf('id="status-key-proof"'),
    );
    for (const r of summary.flatMap((l) => l.rows)) {
      expect(anchors(html).filter((a) => hrefOf(a) === `#${r.id}`).length, r.id).toBe(1);
    }
    for (const m of [...STATUS_KEY.proof.marks, ...STATUS_KEY.use.marks]) {
      expect(out).toContain(m.means);
    }
    // The key names each of its two lists by its label, on a group: a dl takes no name of its own.
    for (const k of ["proof", "use"]) {
      expect(html).toMatch(new RegExp(`<div[^>]*role="group" aria-labelledby="status-key-${k}"`));
      expect(html).not.toMatch(new RegExp(`<dl[^>]*aria-labelledby="status-key-${k}"`));
    }
  });

  it("names each thing left to try in the console under the part it belongs to, by that part's name", () => {
    const console = ITEMS.find((i) => i.id === "web-console");
    const names = (console?.parts ?? []).filter((p) => p.untried === undefined).map((p) => p.name);
    const left = (console?.parts ?? []).flatMap((p) => p.untried ?? []);
    expect(left.length).toBeGreaterThan(0);
    for (const u of left) expect(names, u.area).toContain(u.area);
  });

  it("folds each row's record under its own summary on the landing, and keeps every id on a line that shows", () => {
    const html = board();
    // Every row and every part is one closed native details, its summary the line that shows: its name and marks.
    const folds = [
      ...html.matchAll(
        /<li class="[^"]*" id="([^"]+)" data-row="\1"[^>]*><details class="[^"]*"><summary class="[^"]*">([\s\S]*?)<\/summary>/g,
      ),
    ];
    expect(folds.map((m) => m[1])).toEqual(ENTRIES.map((e) => e.id));
    for (const [, id = "", summary = ""] of folds) {
      const e = ENTRIES.find((x) => x.id === id);
      const word = STATUS_KEY.proof.marks.find((m) => m.id === e?.proof)?.word;
      expect(visibleText(summary), id).toContain(`${e?.name} ${STATUS_KEY.proof.label}: ${word}`);
      // A summary holds phrasing content and its one heading: no list, no link, no paragraph.
      expect(summary, id).not.toMatch(/<(?:ul|ol|li|a|p|div)\b/);
    }
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    // With every fold closed, each row's and part's id, the key's and the gaps' ids are still on what shows.
    const shown = html.replace(/<\/summary>[\s\S]*?<\/details>/g, "</summary></details>");
    const ids = [
      "status",
      "status-key-proof",
      "status-key-use",
      STATUS.gaps.id,
      ...STATUS.gaps.lists.map((l) => l.id),
      ...ENTRIES.map((e) => e.id),
    ];
    for (const id of ids) expect(shown, id).toContain(` id="${id}"`);
    // Not proven yet stays open; the other two lists fold, each saying how many items it holds.
    for (const l of STATUS.gaps.lists) {
      const open = l.id === "gaps-proof";
      for (const g of l.items) expect(shown.includes(g.lead), l.id).toBe(open);
      if (!open) expect(visibleText(shown)).toContain(`${l.title} ${l.items.length} items`);
    }
    // What is left to try in the console is said in full, in its part's record.
    for (const u of PARTS.flatMap((p) => p.untried ?? [])) {
      expect(visibleText(html), u.area).toContain(`${u.area}: ${u.what.replace(/`/g, "")}`);
    }
  });

  it("folds the full board's tried console parts under a line that names them, and always shows what is left", () => {
    const html = fullBoard();
    const parts = ITEMS.find((i) => i.id === "web-console")?.parts ?? [];
    const tried = parts.filter((p) => p.untried === undefined);
    const left = parts.filter((p) => p.untried !== undefined);
    expect(tried.length).toBeGreaterThan(0);
    expect(left.length).toBeGreaterThan(0);
    const fold = html.match(/<details[^>]*>([\s\S]*?)<\/details>/)?.[1] ?? "";
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    const summary = visibleText(fold.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] ?? "");
    for (const p of tried) {
      expect(fold, p.id).toContain(`id="${p.id}"`);
      expect(summary, p.id).toContain(p.name);
    }
    expect(summary).toContain(STATUS_BOARD.partsFold.hint);
    for (const p of left) {
      expect(fold, p.id).not.toContain(`id="${p.id}"`);
      expect(html, p.id).toContain(`id="${p.id}"`);
    }
  });

  it("dates the board by the day of JUDGES.md's Not yet list", () => {
    expect(SOURCES.judges).toContain(`## Not yet, as of ${STATUS_AS_OF}`);
    expect(STATUS_BOARD.eyebrow).toBe(`Status as of ${STATUS_AS_OF}`);
    expect(visibleText(board())).toContain(`Status as of ${STATUS_AS_OF}`);
    expect(SOURCES.judges).toContain(
      "the Canary's board showed 0 visitor attempts and 6 by the team",
    );
    expect(SOURCES.judges).toContain(
      "showed 0 external owners, 0 Canary participants and 0 pilots, beside 2 team vaults",
    );
  });

  it("tells the mainnet vault's three test payments, the 0.25 USDC one on an attested model's proposal", () => {
    const row = ITEMS.find((i) => i.id === "mainnet-vault");
    const what = row?.what ?? "";
    expect(what).toContain("It made three test payments to the owner's own addresses");
    expect(what).toContain("Code rules alone decided the 1.00 USDC Base payout.");
    expect(what).toContain(
      "The 0.25 USDC one was paid on an attested model's proposal, which the code rules allowed.",
    );
    // What is still not done after S2: no customer payment, and spend 1 without the SDK. The online check of the
    // mainnet decisions ran on 2026-11-13 at 17:52 UTC, so the row no longer says it has not.
    expect(row?.limit).toContain("No customer payment yet");
    expect(row?.limit).toContain("Spend 1 was sent without the SDK");
    expect(row?.limit).not.toMatch(/has not run|not been checked online/);
    expect(row?.limit).not.toMatch(/No payment on a model's proposal/);
    // Its evidence: spend 3 on NEAR, what arrived on Base, the S2 run beside the S1 run, and the online check.
    const hrefs = row?.evidence.map((e) => e.href) ?? [];
    for (const href of [
      BOARD_TX.basePayout.url,
      BASE_TX.basePayout.url,
      BOARD_TX.attestedPayout.url,
      BASE_TX.attestedPayout.url,
      BOARD_LINKS.mainnetRunS1,
      BOARD_LINKS.mainnetRunS2,
      BOARD_LINKS.mainnetVerifyOnline,
    ]) {
      expect(hrefs, href).toContain(href);
    }
    // Each claim stands on the S2 record and on JUDGES.md.
    const s2 = flat(text(ROOT, "docs", "evidence", "mainnet-v0", "s2-2026-11-13", "README.md"));
    expect(s2).toContain("**Decided by an attested model and the code rules.**");
    expect(s2).toContain("verdict `allow`, `decided_by` `model+rules`");
    // The S2 record kept what it said at the time of the run, and its dated section gives the later online check.
    expect(s2).toContain("which had not run on this decision when this record was written");
    expect(s2).toContain("## The online check, 2026-11-13");
    expect(s2).toContain("passed O1 and O2 for all three attested decisions, entries 0, 1 and 4");
    expect(s2).toContain("[output](verify-online-2026-11-13.txt)");
    expect(s2).not.toContain("which has not run on this decision");
    expect(SOURCES.judges).toContain(
      "spend 3 paid it to the owner's own Base address, a test: 0.25 USDC sent, 0.2476 USDC arrived",
    );
    // The model run's row tells the 3 mainnet decisions; O1 and O2 passed on them, and the image is still not pinned.
    const model = ITEMS.find((i) => i.id === "attested-model-run");
    expect(model?.what).toContain("On mainnet, the 3 of 2026-11-13 pass A1 to A8 offline.");
    expect(model?.what).toContain("Code refused 2 of them and allowed the third");
    expect(model?.limit).toContain("The TEE measurement is not pinned");
    expect(model?.limit).not.toMatch(/has not run on the 3 mainnet decisions/);
    expect(model?.evidence.map((e) => e.href)).toContain(BOARD_LINKS.mainnetVerifyOnline);
    // On the page, word for word.
    const out = visibleText(board());
    expect(out).toContain(
      "The 0.25 USDC one was paid on an attested model's proposal, which the code rules allowed.",
    );
    expect(out).not.toContain("has not run on the 3 mainnet decisions");
    expect(out).not.toContain("has not run on the vault's 3 attested decisions");
  });

  it("cites the online check of the mainnet vault's 3 attested decisions, and the file says they passed", () => {
    const row = ITEMS.find((i) => i.id === "mainnet-vault");
    const online = row?.evidence.find((e) => e.href === BOARD_LINKS.mainnetVerifyOnline);
    expect(online?.kind).toBe("verify");
    expect(online?.label).toBe("online check, 2026-11-13");
    expect(online?.note).toBe("O1 and O2 pass, 3 of 3");
    expect(BOARD_LINKS.mainnetVerifyOnline).toBe(
      `${REPO_URL}/blob/main/docs/evidence/mainnet-v0/s2-2026-11-13/verify-online-2026-11-13.txt`,
    );
    const log = text(
      ROOT,
      "docs",
      "evidence",
      "mainnet-v0",
      "s2-2026-11-13",
      "verify-online-2026-11-13.txt",
    );
    expect(log).toContain("Probarion verify: v0.probarion.near (mainnet)");
    expect(log).toContain("entries 6, anchors 4");
    expect(log).toContain("8 passed, 0 failed, 0 unproven, 1 skipped");
    expect(log).toContain("\nRESULT: PASS");
    expect(log).toContain(
      "A8 (request binding and mandate match) passes for 3 of 3 attested decisions (seq 0, 1, 4)",
    );
    expect(log).toContain("online: 3 DCAP-genuine TDX quotes bound to this request");
    expect(log).toContain("3 GPU payloads bound to the request nonce and verified by NRAS (O2)");
    // O1 does not pin the measurement: the file says so, and the row next to it keeps that limit.
    expect(log).toContain("measurement not pinned, so quote_verified stays false");
    expect(ITEMS.find((i) => i.id === "attested-model-run")?.limit).toContain(
      "so no check shows which model image ran",
    );
    // On the page, the link is there with its note.
    const html = board();
    expect(html).toContain(BOARD_LINKS.mainnetVerifyOnline);
    expect(visibleText(html)).toContain("O1 and O2 pass, 3 of 3");
  });

  it("no file says any more that O1 and O2 have not run on the mainnet decisions, and each docs page citing the run links it", () => {
    // The read-only run of 2026-11-13 at 17:52 UTC passed O1 and O2 on entries 0, 1 and 4. Evidence files keep what
    // they said at the time of a run, and older CHANGELOG releases keep their words; the Unreleased section is held.
    const docs = join(WEB, "content", "docs");
    const pages = readdirSync(docs, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".mdx"))
      .map((f) => join(docs, f));
    const changelog = text(ROOT, "CHANGELOG.md");
    const start = changelog.indexOf("## Unreleased");
    const unreleased = changelog.slice(start, changelog.indexOf("\n## ", start + 1));
    const texts: [string, string][] = [
      ...[
        "README.md",
        "JUDGES.md",
        "SECURITY.md",
        join("docs", "THREAT_MODEL.md"),
        join("apps", "web", "src", "lib", "site", "facts.ts"),
        join("apps", "web", "src", "lib", "site", "ops-copy.ts"),
      ].map((f): [string, string] => [f, text(ROOT, f)]),
      ...pages.map((f): [string, string] => [f, readFileSync(f, "utf8")]),
      ["CHANGELOG.md, Unreleased", unreleased],
    ];
    const OLD = [
      /have not been checked online/i,
      /O1 and O2 have not (?:run|checked)/i,
      /has not run on (?:it|them|this decision|those attested decisions|the 3 mainnet decisions|the three)\b/i,
      /has not checked the mainnet model decisions/i,
      /mainnet model decisions are not checked online/i,
      /No online check of the attested decisions/i,
    ];
    expect(pages.length).toBeGreaterThan(30);
    expect(start).toBeGreaterThan(0);
    expect(unreleased.length).toBeGreaterThan(1000);
    for (const [name, body] of texts) {
      for (const old of OLD) expect(flat(body), `${name}: ${old}`).not.toMatch(old);
    }
    // Each docs page with the online output among its sources links it.
    const file = "docs/evidence/mainnet-v0/s2-2026-11-13/verify-online-2026-11-13.txt";
    const citing = PAGES.filter((p) => p.sources.includes(file));
    expect(citing.map((p) => p.path).sort()).toEqual([
      "build/let-an-agent-pay",
      "build/sdk-reference",
      "operate/architecture",
      "resources/glossary",
      "start/how-one-payment-works",
      "start/mainnet-payout",
      "start/testnet-and-mainnet",
      "start/what-is-probarion",
      "start/what-works-today",
      "trust/security-model",
      "trust/verifier-checks",
    ]);
    for (const p of citing) {
      expect(text(docs, `${pageFile(p.path)}.mdx`), p.path).toContain(
        `${REPO_URL}/blob/main/${file}`,
      );
    }
  });
});

describe("the status board's evidence", () => {
  const evidence = ENTRIES.flatMap((e) => e.evidence.map((ev) => ({ id: e.id, ...ev })));

  it("links only named constants, this page's sections, the proof page's anchors and docs pages", () => {
    const known = new Set([
      ...strings(LINKS),
      ...strings(TX),
      ...strings(MAINNET_TX),
      ...strings(HERO),
      ...strings(BOARD_TX),
      ...strings(BASE_TX),
      ...strings(BOARD_LINKS),
      ...strings(STORY),
      ...strings(INTEGRATE),
      CONSOLE_ROUTE,
      DEMO_PROOF,
    ]);
    const page = landing();
    for (const { id, href } of evidence) {
      if (known.has(href)) continue;
      if (href.startsWith("#")) {
        expect(page, `${id}: ${href}`).toContain(`id="${href.slice(1)}"`);
      } else if (href.startsWith(`${DEMO_PROOF}#`)) {
        expect(["seq-13", "seq-15", "tee-check"], `${id}: ${href}`).toContain(href.split("#")[1]);
      } else {
        expect(href.startsWith("/docs/"), `${id}: ${href}`).toBe(true);
      }
      expect(linkProblem(href.startsWith("#") ? `/${href}` : href, ""), href).toBeNull();
    }
    // The proof page's anchors: a decision card is id="seq-N", and the TEE check card id="tee-check".
    expect(text(WEB, "src", "components", "proof", "TeeCheckPanel.tsx")).toContain(
      'id="tee-check"',
    );
    for (const seq of [13, 15]) {
      expect(SOURCES.demo).toContain(
        `[entry ${seq}](https://probarion.xyz/proof/demo.vaults.probarion.testnet#seq-${seq})`,
      );
    }
  });

  it("links pages and repository files that exist, and headings that exist in them", () => {
    const links = [
      ...evidence.map((e) => e.href),
      ...strings(STATUS_BOARD.footer).filter((s) => /^(?:https:|\/)/.test(s)),
      ...STATUS.gaps.lists.flatMap((l) =>
        l.items.flatMap((g) => g.parts.flatMap((p) => (typeof p === "string" ? [] : [p.href]))),
      ),
    ];
    for (const href of links) {
      // The Canary's link is the hero's own (the docs' link rules keep their pages off it; the landing's tests check it).
      if (href.startsWith("#") || href === HERO.refused.tryIt.href) continue;
      expect(linkProblem(href, ""), href).toBeNull();
      // A Markdown file's anchor is the slug of one of its headings; a log's #Ln is a line GitHub numbers itself.
      const blob =
        /^https:\/\/github\.com\/probarion\/probarion\/blob\/main\/([^#]+\.md)#(.+)$/.exec(href);
      if (blob) {
        const [, file = "", anchor = ""] = blob;
        const slugger = new GithubSlugger();
        const ids = [...text(ROOT, file).matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
          slugger.slug(m[1] ?? ""),
        );
        expect(ids, href).toContain(anchor);
      }
    }
    // The README's Status heading, for the footer's link.
    expect(BOARD_LINKS.readmeStatus.endsWith("#status")).toBe(true);
    expect(SOURCES.readme).toContain(" ## Status ");
  });

  it("gives the eval's model replay numbers as the committed results give them", () => {
    const latest = JSON.parse(text(ROOT, "eval", "results", "latest.json")) as {
      headline: { money_moved_wrongly: { model_replay: string } };
      runs: { model_replay: { summary?: { model: { attested: string; call_failed: string } } } };
    };
    const model = latest.runs.model_replay.summary?.model;
    expect(model, "the model replay is recorded").toBeDefined();
    const footer = strings(STATUS_BOARD.footer).join("");
    expect(footer).not.toMatch(/not recorded/);
    // "attested" is qualified as everywhere else: A1 to A8 offline (O1 and O2 were not run, the TEE is not pinned).
    expect(footer).toContain(
      `(${model?.attested} attested by A1 to A8 offline, ${model?.call_failed} failed calls, money moved wrongly ${latest.headline.money_moved_wrongly.model_replay})`,
    );
  });

  it("holds every board transaction to the record that names it", () => {
    const proof = JSON.parse(text(ROOT, "docs", "mainnet-proof.json")) as {
      txs: Record<string, { hash: string; network: string; amount_usdc: string | null }>;
    };
    const testnet = JSON.parse(text(ROOT, "contracts", "deployments", "testnet.json"));
    const mainnet = JSON.parse(text(ROOT, "contracts", "deployments", "mainnet.json"));
    const recorded: Record<
      keyof typeof BOARD_TX,
      { network: "testnet" | "mainnet"; hash: string }
    > = {
      trialCreate: { network: "testnet", hash: testnet.trial_vault.create_vault_tx },
      demoCreate: { network: "testnet", hash: testnet.demo_vault.create_vault_tx },
      trialAgent: { network: "testnet", hash: proof.txs.trial_agent_added?.hash ?? "" },
      trialKeyRemoved: {
        network: "testnet",
        hash: proof.txs.trial_spare_agent_removed?.hash ?? "",
      },
      demoFaucet: { network: "testnet", hash: testnet.demo_vault.faucet_mint_tx },
      trialTopup: { network: "testnet", hash: proof.txs.trial_usdc_topup?.hash ?? "" },
      trialWithdraw: { network: "testnet", hash: proof.txs.trial_withdraw?.hash ?? "" },
      demoMandate: { network: "testnet", hash: testnet.demo_vault.create_mandate_tx },
      trialRevoke: { network: "testnet", hash: proof.txs.trial_revoke_mandate_2?.hash ?? "" },
      trialApprove: { network: "testnet", hash: proof.txs.trial_approve_spend_2?.hash ?? "" },
      trialReject: { network: "testnet", hash: proof.txs.trial_reject_spend_4?.hash ?? "" },
      demoFreeze: { network: "testnet", hash: proof.txs.demo_freeze?.hash ?? "" },
      payablesOwn: { network: "testnet", hash: proof.txs.demo_payables_spend_4?.hash ?? "" },
      mcpSpend: { network: "testnet", hash: proof.txs.trial_mcp_spend_1?.hash ?? "" },
      basePayout: { network: "mainnet", hash: mainnet.proof.first_base_payout_tx },
      attestedPayout: { network: "mainnet", hash: mainnet.proof.attested_base_payout_tx },
    };
    for (const [name, fact] of Object.entries(BOARD_TX)) {
      const r = recorded[name as keyof typeof BOARD_TX];
      expect(fact.hash, name).toBe(r.hash);
      expect(fact.url, name).toBe(explorerTxUrl(r.network, r.hash));
      expect(fact.label, name).toBe(`${r.hash.slice(0, 8)}…${r.hash.slice(-4)}`);
    }
    // The proof file's network agrees with the explorer each one links.
    for (const t of Object.values(proof.txs)) {
      const fact = Object.values(BOARD_TX).find((f) => f.hash === t.hash);
      if (fact) expect(fact.url, t.hash).toBe(explorerTxUrl(t.network as "testnet", t.hash));
    }
    // The Base side of the payout, on Base's explorer, as the README and JUDGES.md link it.
    expect(BASE_TX.basePayout.hash).toBe(mainnet.proof.first_base_payout_base_tx);
    expect(BASE_TX.basePayout.label).toBe(
      `${BASE_TX.basePayout.hash.slice(0, 10)}…${BASE_TX.basePayout.hash.slice(-4)}`,
    );
    expect(SOURCES.readme).toContain(BASE_TX.basePayout.url);
    expect(SOURCES.judges).toContain(BASE_TX.basePayout.url);
    expect(SOURCES.judges).toContain("the POA bridge released 0.9976 USDC on Base");
    expect(SOURCES.judges).toContain("spend 2 burned 1.00 USDC");
    // The Base side of spend 3, the payout on an attested model's proposal, the same way.
    expect(BASE_TX.attestedPayout.hash).toBe(mainnet.proof.attested_base_payout_base_tx);
    expect(BASE_TX.attestedPayout.label).toBe(
      `${BASE_TX.attestedPayout.hash.slice(0, 10)}…${BASE_TX.attestedPayout.hash.slice(-4)}`,
    );
    expect(SOURCES.readme).toContain(BASE_TX.attestedPayout.url);
    expect(SOURCES.judges).toContain(BASE_TX.attestedPayout.url);
    expect(SOURCES.judges).toContain("the POA bridge released 0.2476 USDC on Base");
    expect(SOURCES.judges).toContain("spend 3 burned 0.25 USDC");
  });

  it("holds every amount, invoice and refusal a transaction's note gives to the record of that transaction", () => {
    const proof = JSON.parse(text(ROOT, "docs", "mainnet-proof.json")) as {
      txs: Record<string, { hash: string; amount_usdc: string | null; error_code: string | null }>;
    };
    const testnet = JSON.parse(text(ROOT, "contracts", "deployments", "testnet.json")) as {
      smoke: Record<string, string>;
      demo_vault: { spends: { invoice: string; amount: string; spend_tx: string }[] };
    };
    // What each record says of a transaction: its amount in USDC, its invoice, its refusal code.
    const record = new Map<string, { amount?: number; invoice?: string; code?: string }>();
    for (const t of Object.values(proof.txs)) {
      record.set(t.hash, {
        ...(t.amount_usdc === null ? {} : { amount: Number(t.amount_usdc) }),
        ...(t.error_code === null ? {} : { code: t.error_code }),
      });
    }
    for (const sp of testnet.demo_vault.spends) {
      record.set(sp.spend_tx, { amount: Number(sp.amount) / 1e6, invoice: sp.invoice });
    }
    // Every other transaction the deployment records name (create a vault, a mandate, the faucet), with no amount.
    const named = (value: unknown, key = ""): string[] =>
      typeof value === "string"
        ? key.endsWith("_tx")
          ? [value]
          : []
        : value !== null && typeof value === "object"
          ? Object.entries(value).flatMap(([k, v]) => named(v, k))
          : [];
    for (const hash of named(testnet)) if (!record.has(hash)) record.set(hash, {});
    // The faucet's amount, in the README's words for that run.
    const minted =
      /on 2026-11-09 it added (\d+) test USDC to `demo\.vaults\.probarion\.testnet`/.exec(
        SOURCES.readme,
      )?.[1];
    record.set(BOARD_TX.demoFaucet.hash, { amount: Number(minted) });
    // The smoke run's transactions: testnet.json names them, and the README's table of the run gives what each did.
    for (const hash of Object.values(testnet.smoke)) {
      const line = SOURCES.readme.split("|").findIndex((cell) => cell.includes(`/txns/${hash})`));
      const said = SOURCES.readme.split("|")[line + 1] ?? "";
      const amount = /(\d+(?:\.\d+)?) test USDC/.exec(said)?.[1];
      const code = /PROBARION:([A-Za-z]+)/.exec(said)?.[1];
      record.set(hash, {
        ...(amount === undefined ? {} : { amount: Number(amount) }),
        ...(code === undefined ? {} : { code }),
      });
    }
    // The Canary's raw spend (lib/canary/rehearsal.ts, held to its evidence by rehearsal.test.ts).
    record.set(REHEARSAL.txHash, { code: REHEARSAL.contractCode });
    // The Base side of the payout: JUDGES.md's words for what the bridge released.
    const released = /the POA bridge released (\d+\.\d+) USDC on Base/.exec(SOURCES.judges)?.[1];
    record.set(BASE_TX.basePayout.hash, { amount: Number(released) });
    // The Base side of spend 3: the POA bridge's own status record of S2, in base units of 6 decimals.
    const poa = JSON.parse(
      text(ROOT, "docs", "evidence", "mainnet-v0", "s2-2026-11-13", "poa-status.json"),
    ) as { data: { tx_hash: string; transfer_tx_hash: string; withdraw_amount: string } };
    expect(poa.data.tx_hash).toBe(BOARD_TX.attestedPayout.hash);
    expect(poa.data.transfer_tx_hash).toBe(BASE_TX.attestedPayout.hash);
    // The kit's own read of that transfer on Base agrees with the bridge: same tx, same amount, a match.
    const receipt = JSON.parse(
      text(ROOT, "docs", "evidence", "mainnet-v0", "s2-2026-11-13", "base-receipt.json"),
    ) as { tx: string; transfers: { value: string }[]; match: boolean };
    expect(receipt.tx).toBe(BASE_TX.attestedPayout.hash);
    expect(receipt.transfers[0]?.value).toBe(poa.data.withdraw_amount);
    expect(receipt.match).toBe(true);
    record.set(BASE_TX.attestedPayout.hash, { amount: Number(poa.data.withdraw_amount) / 1e6 });

    const facts: TxFact[] = [
      ...Object.values(TX),
      ...Object.values(MAINNET_TX),
      ...Object.values(BOARD_TX),
      ...Object.values(BASE_TX),
      DEMO_PAID_TX,
      HERO.refused.tx,
    ];
    const onBoard = evidence.filter((e) => facts.some((f) => f.url === e.href));
    expect(onBoard.length).toBeGreaterThanOrEqual(20);
    const codes = new Set(
      Object.values(proof.txs).flatMap((t) => (t.error_code ? [t.error_code] : [])),
    );
    for (const ev of onBoard) {
      const fact = facts.find((f) => f.url === ev.href);
      const r = fact ? record.get(fact.hash) : undefined;
      expect(r, `${ev.label}: no record of ${fact?.hash}`).toBeDefined();
      const note = ev.note ?? "";
      const amount = /(\d+(?:\.\d+)?) (?:test )?USDC/.exec(note)?.[1];
      if (amount !== undefined) expect(Number(amount), `${ev.label}: ${note}`).toBe(r?.amount);
      const invoice = /INV-\d+/.exec(note)?.[0];
      if (invoice !== undefined && r?.invoice !== undefined) {
        expect(invoice, `${ev.label}: ${note}`).toBe(r.invoice);
      }
      const code = /^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.exec(note)?.[0];
      if (code !== undefined || codes.has(note) || note === REHEARSAL.contractCode) {
        expect(note, ev.label).toBe(r?.code);
      }
      // Testnet money is test USDC, and mainnet money is real USDC, said as USDC alone.
      if (amount !== undefined) {
        expect(note.includes("test USDC"), `${ev.label}: ${note}`).toBe(ev.kind === "testnet");
      }
    }
    // The invoices the notes name that the deployments do not hold: INV-2009 in mainnet-proof.json's own words.
    expect(proof.txs.demo_payables_spend_4?.hash).toBe(BOARD_TX.payablesOwn.hash);
    expect(JSON.stringify(proof.txs.demo_payables_spend_4)).toContain("Payables paid INV-2009");
  });

  it("holds the npm pages, the explorer pages and the logs' results to their records", () => {
    expect(SOURCES.readme).toContain(BOARD_LINKS.npmMcp);
    expect(SOURCES.readme).toContain(LINKS.npmSdk);
    // The verifier's page: the README's row for `@probarion/core` links it, and it has the form of the SDK's.
    expect(SOURCES.readme).toContain(
      "**Shipped**, on npm as `@probarion/core` 0.1.1 | [`packages/core`](packages/core), [npm](https://www.npmjs.com/package/@probarion/core) |",
    );
    expect(BOARD_LINKS.npmCore).toBe(LINKS.npmSdk.replace("@probarion/sdk", "@probarion/core"));
    // Every address outside the repository is one the README or JUDGES.md links too: none is made up here.
    for (const [name, href] of Object.entries(BOARD_LINKS)) {
      if (href.startsWith(REPO_URL)) continue;
      expect(SOURCES.readme.includes(href) || SOURCES.judges.includes(href), name).toBe(true);
    }
    const logs: [string, string, string, string][] = [
      ["offline-verifier", BOARD_LINKS.demoVerify, "9 passed", "9 passed, 0 failed, 0 unproven"],
      [
        "offline-verifier",
        BOARD_LINKS.mainnetVerify,
        "8 passed, check i skipped",
        "8 passed, 0 failed, 0 unproven, 1 skipped",
      ],
      [
        "reproducible-builds",
        BOARD_LINKS.mainnetVerify,
        "check f: recorded build",
        "code_hash 3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1 is a recorded reproducible build",
      ],
      [
        "attested-model-run",
        LINKS.demoVerifyOnlineA8,
        "O1 and O2 on all 5",
        "online: 5 DCAP-genuine TDX quotes bound to this request",
      ],
      [
        "attested-model-run",
        BOARD_LINKS.canaryVerifyOnline,
        "O1 and O2, 2026-11-11",
        "online: 2 DCAP-genuine TDX quotes bound to this request",
      ],
      [
        "attested-model-run",
        BOARD_LINKS.mainnetVerify,
        "A1 to A8 on all 3",
        "A8 (request binding and mandate match) passes for 3 of 3 attested decisions (seq 0, 1, 4)",
      ],
      [
        "attested-model-run",
        BOARD_LINKS.mainnetVerifyOnline,
        "O1 and O2 on all 3",
        "online: 3 DCAP-genuine TDX quotes bound to this request",
      ],
      [
        "mainnet-vault",
        BOARD_LINKS.mainnetVerifyOnline,
        "O1 and O2 pass, 3 of 3",
        "3 GPU payloads bound to the request nonce and verified by NRAS (O2)",
      ],
    ];
    for (const [id, href, note, line] of logs) {
      expect(evidence.find((e) => e.id === id && e.href === href)?.note, `${id} ${href}`).toBe(
        note,
      );
      const file = href.replace(/^https:\/\/github\.com\/probarion\/probarion\/blob\/main\//, "");
      expect(text(ROOT, file), file).toContain(line);
    }
    // The mainnet verify is the live run after S2, on the whole ledger: its 3 attested decisions pass A1 to A7 too, and
    // it ran without --online. O1 and O2 ran later, in their own file, which the logs above and a test of the rows hold.
    const mainnetLog = text(
      ROOT,
      BOARD_LINKS.mainnetVerify.replace(
        /^https:\/\/github\.com\/probarion\/probarion\/blob\/main\//,
        "",
      ),
    );
    expect(BOARD_LINKS.mainnetVerify).toContain("/s2-2026-11-13/");
    expect(mainnetLog).toContain("entries 6, anchors 4");
    expect(mainnetLog).toContain("3 attested decisions pass A1");
    expect(mainnetLog).toContain("quote not verified offline (run --online for O1)");
    // The later online check covers entry 15, which the row's proof page link opens, as JUDGES.md cites it.
    expect(
      text(ROOT, "docs", "evidence", "demo-vault", "verify-online-a8-2026-11-12.txt"),
    ).toContain("(seq 10, 11, 12, 13, 15)");
    expect(SOURCES.judges).toContain(
      "O1 and O2 in a live run at 16:13 UTC on 2026-11-12 ([output](docs/evidence/demo-vault/verify-online-a8-2026-11-12.txt))",
    );
    expect(text(ROOT, "contracts", "code-hashes.json")).toContain(
      "3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1",
    );
    expect(text(ROOT, "docs", "evidence", "tee-check", "live-2026-11-12.json")).toContain(
      "all four checks pass",
    );
    expect(text(ROOT, "docs", "evidence", "demo-vault", "verify-a8-2026-11-12.txt")).toContain(
      "A8 (request binding and mandate match) passes for 5 of 5 attested decisions",
    );
    expect(text(ROOT, "docs", "evidence", "402-vault", "README.md")).toContain("21st time");
  });

  it("keeps every label short enough for its column, and sets the real-money kinds apart", () => {
    for (const { id, label } of evidence) {
      expect(label.length, `${id}: ${label}`).toBeLessThanOrEqual(EVIDENCE_LABEL_MAX);
    }
    for (const { kind } of evidence) expect(Object.keys(EVIDENCE_KINDS)).toContain(kind);
    // Mainnet and Base evidence appears on the mainnet vault's row and nowhere else.
    const real = evidence.filter((e) => REAL_MONEY_KINDS.includes(e.kind));
    expect(new Set(real.map((e) => e.id))).toEqual(new Set(["mainnet-vault"]));
    const html = board();
    expect(html.match(/data-kind="(?:mainnet|base)"/g)).toHaveLength(real.length);
    // Its Where line is set apart too: the one place in bold.
    expect(html.match(/data-real="true"/g)).toHaveLength(1);
    expect(ITEMS.find((i) => i.id === "mainnet-vault")?.where.place).toBe("Mainnet, real USDC");
  });

  it("gives every row and part a record, and names each transaction by the same short hash", () => {
    for (const e of ENTRIES) expect(e.evidence.length, e.id).toBeGreaterThan(0);
    const facts: TxFact[] = [
      ...Object.values(TX),
      ...Object.values(MAINNET_TX),
      ...Object.values(BOARD_TX),
      ...Object.values(BASE_TX),
      DEMO_PAID_TX,
      HERO.refused.tx,
    ];
    let named = 0;
    for (const ev of evidence) {
      const fact = facts.find((f) => f.url === ev.href);
      if (!fact) {
        expect(ev.label, ev.label).not.toContain("…");
        continue;
      }
      // Its first 8 characters (10 with the 0x of a Base hash) and its last 4, after a short verb.
      const head = fact.hash.slice(0, fact.hash.startsWith("0x") ? 10 : 8);
      const short = `${head}…${fact.hash.slice(-4)}`;
      expect(ev.label.endsWith(` ${short}`), ev.label).toBe(true);
      expect(ev.label.slice(0, -short.length - 1), ev.label).toMatch(/^[A-Za-z][a-z -]*$/);
      named++;
    }
    expect(named).toBeGreaterThanOrEqual(20);
  });

  it("says by its kind what each record is: something to try, a page, a verify output, a transaction or a file", () => {
    const tries = evidence.filter((e) => e.kind === "try").map((e) => e.href);
    expect(tries).toEqual([
      "#try",
      "#verify",
      CONSOLE_ROUTE,
      `${DEMO_PROOF}#tee-check`,
      HERO.refused.tryIt.href,
    ]);
    for (const e of evidence.filter((x) => x.kind === "page")) {
      expect(e.href === DEMO_PROOF || e.href.startsWith(`${DEMO_PROOF}#seq-`), e.label).toBe(true);
    }
    // A verify output is a log or a result file in the evidence, and its note is the result, set in ink.
    const verify = evidence.filter((e) => e.kind === "verify");
    expect(verify.length).toBe(10);
    for (const e of verify) {
      expect(e.href.startsWith(`${REPO_URL}/blob/main/docs/evidence/`), e.label).toBe(true);
      expect(e.href.endsWith(".txt") || e.href.endsWith(".json"), e.label).toBe(true);
      expect(e.note, e.label).toBeDefined();
    }
    expect(RESULT_KINDS).toEqual(["verify"]);
    expect(Object.values(EVIDENCE_KINDS)).not.toContain("Site");
    expect(Object.values(EVIDENCE_KINDS)).not.toContain("Log");
  });

  it("opens this site's pages in this tab and every other address in a new one", () => {
    const html = board();
    const links = anchors(html);
    expect(links.length).toBeGreaterThan(40);
    for (const a of links) {
      const href = hrefOf(a);
      if (href.startsWith("https://")) {
        expect(a, href).toContain('target="_blank"');
        expect(a, href).toContain("(opens in a new tab)");
      } else {
        expect(href.startsWith("/") || href.startsWith("#"), href).toBe(true);
        expect(a, href).not.toContain("target=");
      }
    }
  });
});

describe("the status board's page structure and copy", () => {
  it("nests its headings without a skip: the block's h3 under #verify's h2, a row's h4, a part's h5", () => {
    const html = board();
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(3);
    for (let i = 1; i < levels.length; i++) {
      expect((levels[i] ?? 0) - (levels[i - 1] ?? 0), `heading ${i}`).toBeLessThanOrEqual(1);
    }
    // The board's own h3, then the gaps'. The groups are labels, so every row is an h4 under the board.
    const h3 = [...html.matchAll(/<h3\b[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(h3).toEqual([STATUS.title, STATUS.gaps.title]);
    // Each row, the closing note's own heading, and the three gap lists.
    expect(levels.filter((l) => l === 4)).toHaveLength(ITEMS.length + 1 + STATUS.gaps.lists.length);
    expect(levels.filter((l) => l === 5)).toHaveLength(PARTS.length);
    // On the landing the board is a block of #verify: the h2 before its h3 is the section's.
    const page = landing();
    const before = page.slice(0, page.indexOf('id="status-title"'));
    expect(before.slice(before.lastIndexOf("<h2"))).toContain('id="verify-title"');
    // The full board keeps its own section: its h2, a group's h3, a row's h4, a part's h5.
    const full = [...fullBoard().matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(full[0]).toBe(2);
    expect(full.filter((l) => l === 3)).toHaveLength(BOARD_GROUPS.length + 2);
  });

  it("says each mark in words, to a screen reader too, and keeps the glyphs out of the reading", () => {
    const html = board();
    expect(html.match(/<svg[^>]*aria-hidden="true"/g)?.length).toBe(html.match(/<svg/g)?.length);
    // A summary holds no list: each row's marks are spans, each read after its label.
    expect(html.match(new RegExp(`<span class="${b.cMarks}">`, "g"))).toHaveLength(ENTRIES.length);
    expect(fullBoard().match(/<ul[^>]*aria-label="Status"/g)).toHaveLength(ENTRIES.length);
    const out = visibleText(board());
    expect(out).toContain("Proof: Verified");
    expect(out).toContain("Use: Released");
    expect(out).toContain("Proof: In part");
    expect(out).toContain("Proof: Not tried yet");
  });

  it("ends with what else is built, what the tests check, and then the known gaps", () => {
    const out = visibleText(board());
    const footer = out.indexOf("Also built and tested");
    const checked = out.indexOf("checked against the repository by tests");
    const gaps = out.indexOf(STATUS.gaps.title);
    expect(footer).toBeGreaterThan(out.indexOf("Live attested model run"));
    expect(checked).toBeGreaterThan(footer);
    expect(gaps).toBeGreaterThan(checked);
    // Every gap is said in full, its link's words included.
    const plain = out.replace(/ \(opens in a new tab\)/g, "");
    for (const g of STATUS.gaps.lists.flatMap((l) => l.items)) {
      const said = g.parts.map((p) => (typeof p === "string" ? p : p.label)).join("");
      expect(plain).toContain(`${g.lead} ${said.replace(/`/g, "")}`);
    }
    expect(plain).toContain(
      "No outside review yet. No third party has audited this code. The threat model says what verify does not prove yet.",
    );
    for (const l of STATUS.gaps.lists) {
      expect(out).toContain(l.title);
      for (const g of l.items) expect(out).toContain(g.lead);
    }
  });

  it("links each status pill elsewhere on the page to its row here, so one key explains them all", () => {
    const page = landing();
    // The use cases' ways in are the pills left on the page: the comparison's rows are the docs' now.
    for (const id of ["integrate"]) {
      const at = page.indexOf(`id="${id}"`);
      const section = page.slice(at, page.indexOf("</section>", at));
      const pills = anchors(section).filter((a) => a.includes(STATUS_BOARD.pillSuffix));
      expect(pills.length, id).toBeGreaterThan(0);
      for (const a of pills) {
        const href = hrefOf(a);
        expect(href.startsWith("#"), href).toBe(true);
        // The row exists on the board, and the pill says that row's own pill.
        expect(board(), href).toContain(`id="${href.slice(1)}"`);
        const row = STATUS.rows.find((r) => `#${r.id}` === href);
        expect(a, href).toContain(row?.pill ?? "no row");
      }
    }
    for (const c of INTEGRATE.cards) expect(page).toContain(`href="#${statusOf(c.status).id}"`);
    // The integrate cards draw no pill of their own any more.
    for (const file of ["Integrate.tsx"]) {
      const tsx = text(WEB, "src", "components", "site", file);
      expect(tsx, file).not.toContain("s.pill");
      expect(tsx, file).toContain("<StatusPill row=");
    }
  });

  it("holds the known gaps to the README, JUDGES.md and the docs", () => {
    const quotes: Quote[] = [
      ["judges", "No third party has audited the contracts or the packages."],
      [
        "judges",
        "The request to NEAR AI Cloud is plain JSON over HTTPS, the hosted console reads each invoice",
      ],
      [
        "readme",
        "no Content-Security-Policy yet (owner and approver actions still need a 1 yoctoNEAR wallet prompt",
      ],
      ["readme", "the contracts link near-sdk's unmaintained default `wee_alloc` allocator"],
      [
        "readme",
        "CI has no dependency-audit job (Dependabot alerts are triaged in the review log)",
      ],
      ["works", "The code has no webhook that calls a server of yours."],
      ["works", "An agent pays through the SDK, in its own process"],
      ["works", "There is no price list and no paid plan."],
    ];
    for (const [source, words] of quotes) expect(SOURCES[source], words).toContain(flat(words));
  });

  it("follows the copy rules: no dashes, and no first or only claims", () => {
    const copy = [
      ...strings(STATUS_BOARD),
      ...strings(STATUS_KEY),
      ...strings(STATUS.gaps),
      visibleText(board()),
    ];
    for (const s of copy) {
      expect(s, s).not.toMatch(DASHES);
      expect(s, s).not.toMatch(/\bfirst\b/i);
      expect(s, s).not.toMatch(/\bunhackable\b/i);
      expect(s, s).not.toMatch(/\bthe only\b/i);
    }
    // Mainnet money is called real USDC; testnet money is test USDC.
    const out = visibleText(board());
    expect(out).toContain("real USDC");
    expect(out).not.toMatch(/real test USDC|mainnet test USDC/);
  });

  it("styles the board in its own module, in the site's tokens, with the column labels for a wide screen only", () => {
    const css = text(WEB, "src", "components", "site", "status.module.css");
    const tsx = text(WEB, "src", "components", "site", "StatusBoard.tsx");
    expect(tsx).toContain('import b from "./status.module.css";');
    // The section opens with the landing's shared head, as every other section does; the board's columns are set on
    // its wrap.
    expect(tsx).toMatch(/<LandingSection\s+id="status"\s+wrapClassName=\{b\.board\}/);
    // The column labels repeat what every row says to a screen reader, so they are hidden from it.
    expect(tsx.match(/className=\{`?\$?\{?b\.colLabel[^>]*aria-hidden="true"/g)?.length).toBe(3);
    // Below 1280px no column header shows, so each Where line names itself; from 1280px its label is for a screen
    // reader only, since the header says it.
    expect(css).toMatch(/\.whereLabel {\s*color: var\(--color-mute\);/);
    expect(css).toMatch(
      /@media \(min-width: 1280px\) {[\s\S]*?\.whereLabel {\s*position: absolute;[\s\S]*?clip-path: inset\(50%\);/,
    );
    expect(visibleText(board())).toContain(
      `${STATUS_BOARD.whereLabel} Testnet, v0.probarion.testnet and the factory's vaults`,
    );
    expect(css).toMatch(/\.colLabel {\s*display: none;/);
    expect(css).toMatch(/@media \(min-width: 1280px\) {[\s\S]*?\.colLabel {\s*display: block;/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
