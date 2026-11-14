import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GAS, MAINNET_RECORD, type MainnetRow, repoFile } from "./evidence";
import { COSTS_COPY, CostsCard, MAINNET_COPY, MainnetRecordCard } from "./MainnetSections";

// The two cards of /usage that come from the committed evidence (evidence.test.ts holds the figures to the files).
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const html = (el: ReactElement) => renderToStaticMarkup(el);
const visible = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const hrefs = (h: string) => [...h.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1] ?? "");
const anchors = (h: string) =>
  [...h.matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>(.*?)<\/a>/gs)].map((m) => ({
    href: m[1] ?? "",
    words: visible(m[2] ?? ""),
  }));
const rows = (h: string) =>
  [...h.matchAll(/<tr>(.*?)<\/tr>/gs)].map((m) =>
    [...(m[1] ?? "").matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((c) => visible(c[1] ?? "")),
  );
const record = html(createElement(MainnetRecordCard));
const costs = html(createElement(CostsCard));

describe("the mainnet record card", () => {
  it("names the vault and says what every transaction is: a test by the owner, on an unaudited contract", () => {
    const t = visible(record);
    expect(record).toMatch(/<section id="mainnet"/);
    expect(record).toMatch(/<h2[^>]*>Mainnet \(v0\.probarion\.near\)<\/h2>/);
    expect(t).toContain("Real USDC · NEAR mainnet");
    expect(t).toContain(
      "Every transaction here is a test by the owner, and every payment went to the owner's own accounts: a NEAR account and one Base address. The contract is unaudited, so the amounts are small on purpose.",
    );
  });

  it("leads with the counts: payments, refusals on chain and attested decisions", () => {
    // From the record, so that a refusal added to docs/mainnet-proof.json later does not break this test.
    const r = MAINNET_RECORD;
    const t = visible(record);
    expect(t).toContain(`Payments ${r.payments} ${r.basePayouts} of them to Base`);
    expect(t).toContain(`Refused on chain ${r.refusedOnChain} no USDC moved`);
    expect(t).toContain(
      `Attested decisions ${r.decisions.length} ${r.decisionsPaid} led to a payment, ${r.decisionsRefused} were false refusals`,
    );
  });

  it("has a row for each payment and refusal, with its day, its transactions and what arrived on Base", () => {
    const body = rows(record).slice(1);
    expect(body).toHaveLength(MAINNET_RECORD.rows.length);
    // The rows of 2026-11-11 and 2026-11-13, oldest first. A later row comes after them.
    expect(body.slice(0, 4)).toEqual([
      [
        "2026-11-11 Spend 1, a payment on NEAR. Made before the vault's signed ledger began. NEAR 22oqhg…A56ieE (opens in a new tab)",
        "1.00 USDC",
      ],
      [
        "2026-11-11 Refused on chain with NoMandate: the spend named a mandate that does not exist. No USDC moved. NEAR 2Dabq4…6AtwYh (opens in a new tab)",
        "none",
      ],
      [
        "2026-11-13 Spend 2, a payout to Base through NEAR Intents. Decided by the code rules alone. NEAR BdN7oB…RbrSQ9 (opens in a new tab) Base 0xc2df…e1ea71 (opens in a new tab)",
        "1.00 USDC sent, 0.9976 USDC arrived",
      ],
      [
        "2026-11-13 Spend 3, a payout to Base through NEAR Intents. Decided by an attested model (z-ai/glm-5.3-flash) and the code rules. NEAR 5amtgb…sX9NGH (opens in a new tab) Base 0xc6c4…547ab7 (opens in a new tab)",
        "0.25 USDC sent, 0.2476 USDC arrived",
      ],
    ]);
    // The row's description is its header, so each figure is tied to it. The table has two columns, so that a phone
    // shows the transactions with no sideways scroll.
    expect([...record.matchAll(/<th scope="row"/g)]).toHaveLength(MAINNET_RECORD.rows.length);
    expect(rows(record)[0]).toEqual(["What (UTC day)", "Amount"]);
  });

  it("shows no amount for a refusal on chain, even one that recorded the amount it asked for", () => {
    const refused = MAINNET_RECORD.rows.find((r) => r.kind === "refused_on_chain");
    expect(refused).toBeDefined();
    const asked: MainnetRow = {
      ...(refused as MainnetRow),
      key: "refused_over_cap",
      amount: "50.00",
      errorCode: "OverPerPayment",
    };
    const h = html(
      createElement(MainnetRecordCard, { record: { ...MAINNET_RECORD, rows: [asked] } }),
    );
    const row = rows(h)[1];
    expect(row?.[1]).toBe("none");
    expect(row?.[0]).toContain(
      "Refused on chain with OverPerPayment: the amount was above the mandate's cap per payment. No USDC moved.",
    );
    expect(visible(h)).not.toContain("50.00");
  });

  it("links each NEAR transaction on mainnet's explorer and each Base one on Basescan, each saying it opens a new tab", () => {
    const links = hrefs(record);
    for (const r of MAINNET_RECORD.rows) {
      expect(links).toContain(`https://nearblocks.io/txns/${r.nearTx}`);
      if (r.baseTx) expect(links).toContain(`https://basescan.org/tx/${r.baseTx}`);
    }
    const explorers = anchors(record).filter((a) => /nearblocks\.io|basescan\.org/.test(a.href));
    expect(explorers.length).toBeGreaterThan(MAINNET_RECORD.rows.length);
    for (const a of explorers) expect(a.words, a.href).toMatch(/ \(opens in a new tab\)$/);
  });

  it("links the anchor transaction of each refused decision", () => {
    const refused = MAINNET_RECORD.decisions.filter((d) => d.verdict === "refuse");
    expect(refused).toHaveLength(MAINNET_RECORD.decisionsRefused);
    expect(refused.length).toBeGreaterThan(0);
    expect(visible(record)).toContain(
      "Each is a signed entry in the vault's ledger, anchored on chain:",
    );
    for (const d of refused) {
      expect(d.anchorTx).not.toBeNull();
      expect(hrefs(record)).toContain(`https://nearblocks.io/txns/${d.anchorTx}`);
    }
  });

  it("gives the attestation's caveat and why the refusals were false, each with its record", () => {
    const t = visible(record);
    expect(t).toContain(
      "verify passed A1 to A8 on all of them, and on 2026-11-13 the online check (opens in a new tab) passed O1 (Intel TDX) and O2 (NVIDIA NRAS). The TEE measurement is not pinned, so this does not show which model image ran.",
    );
    expect(t).toContain(
      "The two refused decisions were false: on 2026-11-13 both models proposed the right amount and Base address, and a payee rule that was too strict for a Base payee refused them. Nothing was sent, and PR #142 changed the rule after the run (see the S1 record (opens in a new tab) ).",
    );
    expect(t).toContain(
      "From docs/mainnet-proof.json (opens in a new tab) , updated 2026-11-14 01:27 UTC, as of the page's build. It is not added into the counts below.",
    );
    const links = hrefs(record);
    const blob = "https://github.com/probarion/probarion/blob/main/";
    expect(links).toContain(
      `${blob}docs/evidence/mainnet-v0/s2-2026-11-13/verify-online-2026-11-13.txt`,
    );
    expect(links).toContain(
      `${blob}docs/evidence/mainnet-v0/s1-2026-11-13/README.md#why-the-payout-was-decided-rules-only`,
    );
    expect(links).toContain(`${blob}docs/mainnet-proof.json`);
  });

  it("leaves the false-refusal note out of a record with no refused decision", () => {
    const none = html(
      createElement(MainnetRecordCard, {
        record: { ...MAINNET_RECORD, decisions: [], decisionsPaid: 0, decisionsRefused: 0 },
      }),
    );
    expect(visible(none)).not.toContain("The refusals were false");
    expect(visible(none)).toContain(
      "Attested decisions 0 0 led to a payment, 0 were false refusals",
    );
  });
});

describe("the costs card", () => {
  it("is the target of the unit costs' gas row, titled What it costs", () => {
    expect(costs).toMatch(/<section id="costs"/);
    expect(costs).toMatch(/<h2[^>]*>What it costs<\/h2>/);
    expect(visible(costs)).toContain(
      "Each figure links the record it comes from. Nothing is converted to dollars.",
    );
    expect(visible(costs)).not.toContain("$");
  });

  it("has each figure with its evidence, in two columns, so that a phone shows every link", () => {
    expect(rows(costs)[0]).toEqual(["Cost", "Amount"]);
    expect(rows(costs).slice(1)).toEqual([
      ["Gas, spend 1 (a payment on NEAR)", "0.000769 NEAR (opens in a new tab) (8.3546 Tgas)"],
      ["Gas, a spend refused on chain", "0.000165 NEAR (opens in a new tab) (1.8723 Tgas)"],
      ["Gas, spend 2 (a payout to Base)", "0.001423 NEAR (opens in a new tab) (15.3479 Tgas)"],
      ["Gas, spend 3 (a payout to Base)", "0.001424 NEAR (opens in a new tab) (15.3563 Tgas)"],
      [
        "Bridge fee, each of 2 payouts to Base",
        "0.0024 USDC S1 poa-status.json (opens in a new tab) S2 poa-status.json (opens in a new tab)",
      ],
      ["Probarion fee", "none: the contract has no fee path (opens in a new tab)"],
      [
        "Vault deposit, testnet",
        "3.23352 test NEAR testnet.json (opens in a new tab) runway.ts (opens in a new tab)",
      ],
    ]);
    // A gas figure is the link to the reading it comes from, and "none" links the contract's spend.
    const links = anchors(costs);
    for (const g of GAS) {
      expect(links).toContainEqual({
        href: repoFile(g.source),
        words: `${g.near} NEAR (opens in a new tab)`,
      });
    }
    expect(links).toContainEqual({
      href: repoFile("contracts/vault/src/spend.rs"),
      words: "none: the contract has no fee path (opens in a new tab)",
    });
  });

  it("says what the gas covers and leaves out, whose the fee is, and why there is no mainnet deposit", () => {
    const t = visible(costs);
    expect(t).toContain(COSTS_COPY.gasNote("2026-11-13"));
    expect(t).toContain(COSTS_COPY.feeNote);
    expect(t).toContain(
      "the factory's 0.5 NEAR min_deposit plus the console's estimate of the storage for the vault's copy of the code. It stays in the vault. There is no mainnet figure: the mainnet factory is not deployed.",
    );
  });

  it("drops the deposit row and its note when the factory record has no version, and the gas note with no reading", () => {
    const bare = visible(html(createElement(CostsCard, { gas: [], deposit: null })));
    expect(bare).not.toContain("Vault deposit");
    expect(bare).not.toContain("The deposit is");
    expect(bare).not.toContain("Gas is burned");
    expect(bare).toContain("Probarion fee none: the contract has no fee path");
    expect(GAS.length).toBeGreaterThan(0);
  });

  it("links only files of this repository on main", () => {
    for (const href of hrefs(costs)) {
      const path = href.replace("https://github.com/probarion/probarion/blob/main/", "");
      expect(path, href).not.toBe(href);
      expect(existsSync(join(ROOT, path)), path).toBe(true);
    }
  });
});

describe("the copy of both cards", () => {
  /** Every string a visitor can be shown. */
  const strings = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (typeof value === "function") return [];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
    return [];
  };

  it("makes no promise and uses no dash in a sentence", () => {
    const all = [...strings(MAINNET_COPY), ...strings(COSTS_COPY), visible(record), visible(costs)];
    expect(all.filter((s) => /\bnever\b|guarantee|100\s?%|unhackable|\bfirst\b/i.test(s))).toEqual(
      [],
    );
    // An em dash or an en dash, written as escapes so that this file has none either.
    expect(all.filter((s) => /[\u2014\u2013]/.test(s))).toEqual([]);
  });

  it("does not pitch a refusal as a win", () => {
    const t = `${visible(record)} ${visible(costs)}`;
    expect(t).not.toMatch(/blocked an attack|caught|stopped an attack|refused correctly/i);
    expect(t).toContain("were false refusals");
  });
});
