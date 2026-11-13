// The landing's status board (components/site/StatusBoard.tsx): every row stands on a status row, every mark is held to
// the words of the record that backs it, every evidence link to a named constant and its source, and the copy to the
// site's rules. Nothing here fetches: links are checked against the repository and the transactions it records.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import { StatusBoard } from "@/components/site/StatusBoard";
import { explorerTxUrl } from "@/lib/config";
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
  STATUS,
  STATUS_AS_OF,
  STATUS_BOARD,
  STATUS_KEY,
  STORY,
  TX,
  type UseMark,
} from "@/lib/site/facts";
import { linkProblem } from "./docs-helpers";

const WEB = fileURLToPath(new URL("..", import.meta.url));
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

const board = () => renderToStaticMarkup(createElement(StatusBoard));
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
      ["judges", "A payout through NEAR Intents on mainnet"],
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
  "web-console-alerts": {
    proof: [
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

  it("names, in the key, the rows of each proof mark, computed from the board", () => {
    const which = proofSummary();
    const verified = ITEMS.filter((i) => i.proof === "verified").length;
    expect(which.verified).toBe(`${verified} of the ${ITEMS.length} rows.`);
    expect(which.verified).toBe("10 of the 13 rows.");
    expect(which.part).toBe(
      "The web console and the attested model run, whose TEE image is not pinned.",
    );
    expect(which.untried).toBe(
      "The Chrome extension end to end; in the console, email alerts, the Base top-up, the approval page on a phone and two ledger key guards.",
    );
    // Every untried thing on the board is named there.
    for (const u of PARTS.flatMap((p) => p.untried ?? [])) expect(which.untried).toContain(u.short);
    const out = visibleText(board());
    for (const m of STATUS_KEY.proof.marks) {
      expect(out).toContain(m.means);
      expect(out).toContain(which[m.id]);
    }
    for (const m of STATUS_KEY.use.marks) expect(out).toContain(m.means);
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
    // Where the record holds an amount, the note says the same amount.
    const byHash = new Map(Object.values(proof.txs).map((t) => [t.hash, t.amount_usdc]));
    for (const ev of evidence) {
      const fact = Object.values(BOARD_TX).find((f) => f.url === ev.href);
      const amount = fact ? byHash.get(fact.hash) : undefined;
      if (!amount) continue;
      const said = /(\d+(?:\.\d+)?) (?:test )?USDC/.exec(ev.note ?? "")?.[1];
      expect(Number(said), `${ev.label}: ${ev.note}`).toBe(Number(amount));
    }
    // The Base side of the payout, on Base's explorer, as the README and JUDGES.md link it.
    expect(BASE_TX.hash).toBe(mainnet.proof.first_base_payout_base_tx);
    expect(BASE_TX.label).toBe(`${BASE_TX.hash.slice(0, 10)}…${BASE_TX.hash.slice(-4)}`);
    expect(SOURCES.readme).toContain(BASE_TX.url);
    expect(SOURCES.judges).toContain(BASE_TX.url);
    expect(SOURCES.judges).toContain("the POA bridge released 0.9976 USDC on Base");
    expect(SOURCES.judges).toContain("spend 2 burned 1.00 USDC");
  });

  it("holds the npm pages and the logs' results to their records", () => {
    expect(SOURCES.readme).toContain(BOARD_LINKS.npmMcp);
    expect(SOURCES.readme).toContain(LINKS.npmSdk);
    // The verifier's page has the form of the SDK's, for the package the README says is on npm.
    expect(BOARD_LINKS.npmCore).toBe(LINKS.npmSdk.replace("@probarion/sdk", "@probarion/core"));
    expect(SOURCES.readme).toContain("**Shipped**, on npm as `@probarion/core` 0.1.1");
    const logs: [string, string, string][] = [
      [BOARD_LINKS.demoVerify, "9 passed", "9 passed, 0 failed, 0 unproven"],
      [
        BOARD_LINKS.mainnetVerify,
        "8 passed, check i skipped",
        "8 passed, 0 failed, 0 unproven, 1 skipped",
      ],
    ];
    for (const [href, note, line] of logs) {
      expect(evidence.find((e) => e.href === href)?.note).toBe(note);
      const file = href.replace(/^https:\/\/github\.com\/probarion\/probarion\/blob\/main\//, "");
      expect(text(ROOT, file), file).toContain(line);
    }
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
  it("nests its headings without a skip: the section's h2, a group's h3, a row's h4, a part's h5", () => {
    const html = board();
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(2);
    for (let i = 1; i < levels.length; i++) {
      expect((levels[i] ?? 0) - (levels[i - 1] ?? 0), `heading ${i}`).toBeLessThanOrEqual(1);
    }
    expect(levels.filter((l) => l === 3)).toHaveLength(BOARD_GROUPS.length + 1);
    expect(levels.filter((l) => l === 5)).toHaveLength(PARTS.length);
  });

  it("says each mark in words, to a screen reader too, and keeps the glyphs out of the reading", () => {
    const html = board();
    expect(html.match(/<svg[^>]*aria-hidden="true"/g)?.length).toBe(html.match(/<svg/g)?.length);
    expect(html.match(/<ul[^>]*aria-label="Status"/g)).toHaveLength(ENTRIES.length);
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
    expect(out.replace(/ \(opens in a new tab\)/g, "")).toContain(
      `${STATUS.gaps.auditBefore}${STATUS.gaps.auditLink}${STATUS.gaps.auditAfter.replace(/`/g, "")}`,
    );
    expect(out).toContain(STATUS.gaps.v0.replace(/`/g, ""));
    for (const l of STATUS.gaps.lists) {
      expect(out).toContain(l.title);
      for (const g of l.items) expect(out).toContain(g.lead);
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
    // The section keeps the landing's own section classes, as every other section does.
    expect(tsx).toMatch(/<section className=\{`\$\{s\.section\} \$\{s\.flush\}`\} id="status">/);
    // The column labels repeat what every row says to a screen reader, so they are hidden from it.
    expect(tsx.match(/className=\{`?\$?\{?b\.colLabel[^>]*aria-hidden="true"/g)?.length).toBe(3);
    expect(css).toMatch(/\.colLabel {\s*display: none;/);
    expect(css).toMatch(/@media \(min-width: 1280px\) {[\s\S]*?\.colLabel {\s*display: block;/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
