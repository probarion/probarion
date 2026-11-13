// The journey's record on NEAR testnet (audit P1-5): the four real invoices, the attested decisions and their
// evidence links. Every row is held to the demo vault's evidence in docs/evidence/demo-vault, the Canary's in
// docs/evidence/canary-vault and the record in contracts/deployments/testnet.json, so the record cannot drift from
// what the chain and the signed ledgers show.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import j from "@/components/site/journey.module.css";
import { explorerTxUrl } from "@/lib/config";
import { findPage } from "@/lib/docs/registry";
import { REPO_URL } from "@/lib/proof/cli";
import {
  ATTESTED,
  type CopyPart,
  type EvidenceSlot,
  JOURNEY,
  JOURNEY_IDS,
  STORY,
} from "@/lib/site/facts";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "..", "..");
const EVIDENCE = "docs/evidence/demo-vault";
const LEDGER = `${EVIDENCE}/ledger-2026-11-09.jsonl`;
const read = (path: string) => readFileSync(join(ROOT, path));
const sha256 = (path: string) => createHash("sha256").update(read(path)).digest("hex");

type Rule = { id: string; outcome: string };
type Body = {
  seq: number;
  kind: string;
  verdict?: string;
  decided_by?: string;
  invoice_hash: string;
  amount?: string;
  proposal: unknown;
  evidence: unknown;
  rules: Rule[];
  contract: { tx_hash: string | null; status: string; spend_id: number } | null;
};
const ledgerOf = (path: string) =>
  read(path)
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { body: Body }).body);
const ledger = ledgerOf(LEDGER);
/** The demo vault's ledger after the filmed run: seventeen entries, the five attested decisions among them. */
const video = ledgerOf(`${EVIDENCE}/ledger-2026-11-12-video.jsonl`);
const demo = JSON.parse(read("contracts/deployments/testnet.json").toString("utf8")).demo_vault as {
  account: string;
  payee: string;
  spends: { id: number; invoice: string; amount: string; spend_tx: string; approve_tx?: string }[];
  refusals: { invoice: string; rule: string; ledger_seq: number }[];
};
const snapshot = JSON.parse(read(`${EVIDENCE}/snapshot-2026-11-09.json`).toString("utf8")) as {
  chain: {
    mandates: {
      id: number;
      max_per_payment: string;
      approval_above: string;
      payee: { account_id: string };
    }[];
  };
};
const [mandate] = snapshot.chain.mandates;
const html = renderToStaticMarkup(createElement(Home));

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
/** The invoices' table, as rendered. */
const invoiceTable = () => {
  const at = html.indexOf(`<table class="${j.inv}"`);
  return html.slice(at, html.indexOf("</table>", at));
};
type Card = (typeof STORY.invoices)[number];
const linksOf = (slot: EvidenceSlot) => (typeof slot === "string" ? [] : slot);
const card = (invoice: string, again = false) => {
  const found = STORY.invoices.find((c) => c.invoice === invoice && "again" in c === again);
  if (found === undefined) throw new Error(`no row ${invoice}${again ? " again" : ""}`);
  return found;
};
const name = (c: Card) => ("again" in c ? `${c.invoice} ${c.again}` : c.invoice);
/** The ledger lines a link points at (`#L4` or `#L1-L3`), as the entries' seq numbers. */
const seqsOf = (url: string) => {
  const m = url.match(/#L(\d+)(?:-L(\d+))?$/);
  if (m === null) throw new Error(`not a line link: ${url}`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  return Array.from({ length: to - from + 1 }, (_, i) => ledger[from - 1 + i]?.seq);
};
/** Every link the record names: the invoices' evidence, the attested table, the notes and the closing row. */
const hrefsOf = (parts: readonly CopyPart[]) =>
  parts.flatMap((p) => (typeof p === "string" ? [] : [p.href]));
const RECORD_LINKS = [
  ...STORY.invoices.flatMap((c) =>
    [c.evidence.invoice, c.evidence.tx, c.evidence.ledger].flatMap(linksOf).map((l) => l.url),
  ),
  ...ATTESTED.ledgers.flatMap((l) => [...hrefsOf(l.name), ...hrefsOf(l.sub)]),
  ...ATTESTED.rows.flatMap((r) => r.cells.flatMap((c) => hrefsOf(c.detail))),
  ...ATTESTED.paid.txs.map((t) => t.tx.url),
  ATTESTED.more.href,
  ...JOURNEY.steps.flatMap((s) => s.note?.lines.flatMap((l) => hrefsOf(l.parts)) ?? []),
  ...JOURNEY.steps.flatMap((s) => (s.tryIt === undefined ? [] : [s.tryIt.href])),
  STORY.proof.href,
  STORY.files.url,
];

describe("the journey's four invoices on the testnet demo vault (audit P1-5)", () => {
  it("says who sent them, in the words the audit asks for", () => {
    expect(STORY.caption).toBe("Invoices we sent to our own demo vault on NEAR testnet.");
    expect(STORY.title).toBe("Four invoices on the testnet demo vault");
    expect(STORY.eyebrow).toBe("As it ran on NEAR testnet");
  });

  it("closes the journey section, after its five steps, with the proof page link", () => {
    // The journey nests the steps' scroll regions, which are sections too, so it ends where Integrate begins.
    const section = html.slice(html.indexOf('id="payment"'), html.indexOf('id="integrate"'));
    expect(html.indexOf('id="integrate"')).toBeGreaterThan(html.indexOf('id="payment"'));
    const lastStep = text(section).lastIndexOf(JOURNEY.steps[4]?.title ?? "missing");
    const story = text(section).indexOf(STORY.title);
    expect(lastStep).toBeGreaterThan(0);
    expect(story).toBeGreaterThan(lastStep);
    for (const words of [
      STORY.eyebrow,
      STORY.caption,
      ...STORY.invoices.flatMap((c) => [name(c), c.outcome]),
    ]) {
      expect(text(section)).toContain(words);
    }
    expect(section).toContain(`href="${STORY.proof.href}"`);
    expect(STORY.proof.href).toBe(`/proof/${demo.account}`);
    expect(STORY.proof.text).toBe(
      "The demo vault's proof page runs checks a to i on its ledger and the chain.",
    );
  });

  it("is one record in two tables, each named by its heading, in the order of the page", () => {
    const record = html.indexOf(`id="${JOURNEY_IDS.record}"`);
    const invoices = html.indexOf(
      `<table class="${j.inv}" aria-labelledby="${JOURNEY_IDS.invoices}"`,
    );
    const attested = html.indexOf(
      `<table class="${j.matrix}" aria-labelledby="${JOURNEY_IDS.attested}-title"`,
    );
    expect(record).toBeGreaterThan(0);
    expect(invoices).toBeGreaterThan(record);
    expect(attested).toBeGreaterThan(invoices);
    expect(html).toContain(
      `<h3 class="${j.partTitle}" id="${JOURNEY_IDS.invoices}">${STORY.title}</h3>`,
    );
    expect(html).toContain(
      `<h3 class="${j.partTitle}" id="${JOURNEY_IDS.attested}-title">${ATTESTED.title}</h3>`,
    );
    // Both tables keep their semantics when the stylesheet turns them into blocks on a phone.
    for (const role of ["table", "rowgroup", "row", "columnheader", "rowheader", "cell"]) {
      expect(html, role).toContain(`role="${role}"`);
    }
    // The steps keep theirs too, with list-style none.
    expect(html).toMatch(new RegExp(`<ol class="${j.steps}" role="list">`));
  });

  it("states the mandate as the chain has it, and the one payee whatever an invoice says", () => {
    expect(mandate?.payee.account_id).toBe(demo.payee);
    expect(mandate?.max_per_payment).toBe("5000000");
    expect(mandate?.approval_above).toBe("3000000");
    expect(STORY.intro).toBe(
      "Its mandate pays `probarion-payee.testnet`, at most 5 test USDC a payment, and holds anything above 3 for an approver. Whatever an invoice says, the money can only go to that payee. No model read these invoices: the code read each amount, and nothing was sent until the owner confirmed it in their wallet.",
    );
  });

  it("says no model read them, as every first decision in the ledger shows", () => {
    expect(ledger.every((e) => e.proposal === null)).toBe(true);
    for (const id of ["INV-2001", "INV-2002", "INV-2003"]) {
      const first = ledger.find((e) => e.invoice_hash === sha256(`${EVIDENCE}/invoice-${id}.txt`));
      expect(
        first?.rules.map((r) => r.id),
        id,
      ).toContain("custom.owner_confirms_without_model");
    }
  });

  it("gives every row the same three evidence slots, in the same order, each a link or the reason there is none", () => {
    expect(STORY.slots).toEqual({ invoice: "Invoice", tx: "Transaction", ledger: "Ledger" });
    for (const c of STORY.invoices) {
      expect(Object.keys(c.evidence), name(c)).toEqual(["invoice", "tx", "ledger"]);
    }
    const out = text(html);
    for (const c of STORY.invoices) {
      for (const slot of [c.evidence.invoice, c.evidence.tx, c.evidence.ledger]) {
        if (typeof slot === "string") expect(out, name(c)).toContain(slot);
        else expect(slot.length, name(c)).toBeGreaterThan(0);
      }
    }
    const tbody = invoiceTable();
    expect(tbody.split(`<dl class="${j.evl}">`).length - 1).toBe(STORY.invoices.length);
    expect(tbody.split("<dt>Invoice</dt>").length - 1).toBe(STORY.invoices.length);
    expect(tbody.split("<dt>Transaction</dt>").length - 1).toBe(STORY.invoices.length);
    expect(tbody.split("<dt>Ledger</dt>").length - 1).toBe(STORY.invoices.length);
  });

  it("links each invoice row to the exact file the chain hashed, by the file's own name", () => {
    for (const c of STORY.invoices) {
      if ("again" in c) continue;
      const path = `${EVIDENCE}/invoice-${c.invoice}.txt`;
      expect(linksOf(c.evidence.invoice), c.invoice).toEqual([
        { label: `invoice-${c.invoice}.txt`, url: `${REPO_URL}/blob/main/${path}` },
      ]);
      expect(read(path).toString("utf8"), c.invoice).toContain(`Invoice ${c.invoice}`);
    }
    expect(read(`${EVIDENCE}/invoice-INV-2002.txt`).toString("utf8")).toContain(
      "We changed banks.",
    );
  });

  it("links every ledger entry of an invoice, and only that invoice's entries", () => {
    for (const c of STORY.invoices) {
      const [ledgerLink] = linksOf(c.evidence.ledger);
      if (ledgerLink === undefined) continue;
      expect(ledgerLink.url.startsWith(`${REPO_URL}/blob/main/${LEDGER}#L`), name(c)).toBe(true);
      const hash = sha256(`${EVIDENCE}/invoice-${c.invoice}.txt`);
      expect(seqsOf(ledgerLink.url), name(c)).toEqual(
        ledger.filter((e) => e.invoice_hash === hash).map((e) => e.seq),
      );
      const seqs = seqsOf(ledgerLink.url);
      const label = seqs.length === 1 ? `Entry ${seqs[0]}` : `Entries ${seqs[0]} to ${seqs.at(-1)}`;
      expect(ledgerLink.label, name(c)).toBe(label);
    }
  });

  it("pays INV-2001 with spend 1, the transaction the deployment record names", () => {
    const paid = card("INV-2001");
    const spend = demo.spends.find((s) => s.id === 1);
    expect(spend?.invoice).toBe("INV-2001");
    expect(spend?.amount).toBe("2000000");
    expect(paid.outcome).toBe("Paid");
    expect(paid.tone).toBe("paid");
    expect(paid.asks).toBe("2 test USDC to the mandate's payee");
    expect(linksOf(paid.evidence.tx)).toEqual([
      { label: "HFyW61UZ…dQp1", url: explorerTxUrl("testnet", spend?.spend_tx ?? "") },
    ]);
  });

  it("refuses the same file again on upload, in the console's own words, with nothing in the ledger", () => {
    const again = card("INV-2001", true);
    expect("again" in again ? again.again : undefined).toBe("sent again");
    expect(again.outcome).toBe("Refused on upload");
    expect(again.evidence).toEqual({
      invoice: "Same file as above",
      tx: "None, nothing was sent",
      ledger: "No entry",
    });
    const route = readFileSync(
      join(WEB, "src", "app", "api", "console", "[vault]", "invoices", "route.ts"),
      "utf8",
    );
    expect(route).toContain('"This invoice was already processed."');
    expect(again.body).toContain('"This invoice was already processed."');
    // Spend 1's three entries are all the ledger holds for that file: the second upload added none.
    const hash = sha256(`${EVIDENCE}/invoice-INV-2001.txt`);
    expect(ledger.filter((e) => e.invoice_hash === hash).map((e) => e.kind)).toEqual([
      "decision",
      "decision",
      "payment",
    ]);
  });

  it("refuses the changed-bank invoice by code, with the rule the signed ledger records", () => {
    const changed = card("INV-2002");
    expect(changed.outcome).toBe("Refused by code");
    expect(demo.refusals).toEqual([
      { invoice: "INV-2002", rule: "mandate.payee_mismatch", ledger_seq: 3 },
    ]);
    expect(changed.body).toContain("`mandate.payee_mismatch`");
    expect(changed.body).toContain("entry 3");
    const entry = ledger.find((e) => e.seq === 3);
    expect(entry?.verdict).toBe("refuse");
    expect(entry?.rules).toContainEqual(
      expect.objectContaining({ id: "mandate.payee_mismatch", outcome: "refuse" }),
    );
    expect(changed.asks).toBe('"We changed banks": 2 test USDC to `new-account.testnet`');
    expect(demo.spends.map((s) => s.invoice)).not.toContain("INV-2002");
    // Nothing was sent, and the row says so where its transaction would be.
    expect(changed.evidence.tx).toBe("None, nothing was sent");
  });

  it("holds INV-2003 above the approval limit, then pays it on the approver's approval", () => {
    const held = card("INV-2003");
    const spend = demo.spends.find((s) => s.id === 2);
    expect(spend?.invoice).toBe("INV-2003");
    expect(spend?.amount).toBe("4000000");
    expect(held.outcome).toBe("Held, then paid");
    expect(held.tone).toBe("held");
    expect(held.asks).toBe("4 test USDC, above the 3 USDC approval limit");
    expect(linksOf(held.evidence.tx)).toEqual([
      {
        verb: "Held",
        label: "6oDNZEUB…y2Tb",
        url: explorerTxUrl("testnet", spend?.spend_tx ?? ""),
      },
      {
        verb: "Approved",
        label: "47VCARhw…NCJf",
        url: explorerTxUrl("testnet", spend?.approve_tx ?? ""),
      },
    ]);
  });

  it("marks each outcome with a quiet label and its own mark, not a status pill", () => {
    expect(STORY.invoices.map((c) => c.tone)).toEqual(["paid", "refused", "refused", "held"]);
    const table = invoiceTable();
    for (const tone of [j.outPaid, j.outRefused, j.outHeld]) {
      expect(table).toContain(`<span class="${j.out} ${tone}"><svg class="${j.mark}"`);
    }
    expect(table).not.toMatch(/pill/i);
  });

  it("shortens each transaction hash to its first 8 and last 4 characters", () => {
    const txs = [
      ...STORY.invoices.flatMap((c) => linksOf(c.evidence.tx)),
      ...ATTESTED.paid.txs.map((t) => ({ label: t.tx.label, url: t.tx.url })),
    ];
    expect(txs.length).toBe(5);
    for (const l of txs) {
      const hash = l.url.match(/\/txns\/([1-9A-HJ-NP-Za-km-z]+)$/)?.[1];
      expect(hash, l.url).toBeDefined();
      expect(l.label).toBe(`${hash?.slice(0, 8)}…${hash?.slice(-4)}`);
    }
  });
});

describe("the journey's attested decisions on testnet", () => {
  it("names the demo vault's five: later runs on the same vault, not the four invoices above", () => {
    expect(ATTESTED.caption).toBe(
      "The demo vault's five came later, from Payables runs on 2026-11-11 and 2026-11-12: invoices INV-2006 to INV-2010, ledger entries 10 to 13 and 15, not the four invoices above. The Canary is a separate vault.",
    );
    // The attested decisions of the demo vault's ledger are entries 10 to 13 and 15, one per invoice INV-2006 to 2010.
    const attested = video.filter((e) => e.kind === "decision" && Boolean(e.evidence));
    expect(attested.map((e) => e.seq)).toEqual([10, 11, 12, 13, 15]);
    expect(attested.map((e) => e.decided_by)).toEqual(Array(5).fill("model+rules"));
    const ids = ["INV-2006", "INV-2007", "INV-2008", "INV-2009", "INV-2010"];
    expect(attested.map((e) => e.invoice_hash)).toEqual(
      ids.map((id) => sha256(`${EVIDENCE}/invoice-${id}.txt`)),
    );
    // None of them is one of the four invoices of the table above.
    const four = ["INV-2001", "INV-2002", "INV-2003"].map((id) =>
      sha256(`${EVIDENCE}/invoice-${id}.txt`),
    );
    for (const e of attested) expect(four).not.toContain(e.invoice_hash);
    // The Canary's two are in its own ledger, of another vault.
    const canary = ledgerOf("docs/evidence/canary-vault/ledger-2026-11-10.jsonl");
    expect(
      canary.filter((e) => e.kind === "decision" && Boolean(e.evidence)).map((e) => e.seq),
    ).toEqual([1, 2]);
    expect(html).toContain(
      `<p class="${j.attCap}">${ATTESTED.caption.replace(/'/g, "&#x27;")}</p>`,
    );
  });

  it("pays spends 4 and 5 on the two of the five the code allowed, as the ledger records them", () => {
    expect(ATTESTED.paid.text).toBe(
      "On 2026-11-12 the code allowed two of the five, entries 13 and 15 (INV-2009 and INV-2010), and the vault paid each invoice, 2.00 test USDC, on testnet.",
    );
    const allowed = video.filter(
      (e) => e.kind === "decision" && Boolean(e.evidence) && e.verdict === "allow",
    );
    expect(allowed.map((e) => e.seq)).toEqual([13, 15]);
    expect(allowed.map((e) => e.invoice_hash)).toEqual(
      ["INV-2009", "INV-2010"].map((id) => sha256(`${EVIDENCE}/invoice-${id}.txt`)),
    );
    expect(allowed.map((e) => e.amount)).toEqual(["2000000", "2000000"]);
    const [four, five] = ATTESTED.paid.txs;
    expect([four?.label, five?.label]).toEqual(["Spend 4", "Spend 5"]);
    // Each spend's payment result names its transaction, paid, right after its decision.
    for (const [spend, seq, t] of [
      [4, 14, four],
      [5, 16, five],
    ] as const) {
      const entry = video.find((e) => e.seq === seq);
      expect(entry?.kind, `spend ${spend}`).toBe("payment");
      expect(entry?.contract, `spend ${spend}`).toMatchObject({
        tx_hash: t?.tx.hash,
        status: "paid",
        spend_id: spend,
      });
      expect(entry?.invoice_hash).toBe(video.find((e) => e.seq === seq - 1)?.invoice_hash);
      expect(t?.tx.url).toBe(explorerTxUrl("testnet", t?.tx.hash ?? ""));
    }
    const readme = read(`${EVIDENCE}/README.md`).toString("utf8");
    expect(readme).toContain(`[\`EA7MbLts…\`](${four?.tx.url})`);
    expect(readme).toContain(`[\`3YEGw5Qd…\`](${five?.tx.url})`);
    for (const t of ATTESTED.paid.txs) expect(html).toContain(`href="${t.tx.url}"`);
  });
});

describe("the journey's links", () => {
  it("point only at files, headings, anchors and pages that exist", () => {
    expect(RECORD_LINKS.length).toBeGreaterThan(20);
    for (const href of RECORD_LINKS) {
      expect(html, href).toContain(`href="${href}"`);
      if (href.startsWith(`${REPO_URL}/blob/main/`)) {
        const [path = "", anchor] = href.slice(`${REPO_URL}/blob/main/`.length).split("#");
        expect(existsSync(join(ROOT, ...path.split("/"))), href).toBe(true);
        if (anchor !== undefined && !/^L\d+(-L\d+)?$/.test(anchor)) {
          // A Markdown heading, by GitHub's slug.
          const slugs = read(path)
            .toString("utf8")
            .split("\n")
            .filter((l) => /^#{1,6} /.test(l))
            .map((l) =>
              l
                .replace(/^#+ /, "")
                .toLowerCase()
                .replace(/[^\w\s-]/g, "")
                .replace(/\s/g, "-"),
            );
          expect(slugs, href).toContain(anchor);
        }
      } else if (href.startsWith("https://testnet.nearblocks.io/txns/")) {
        expect(href).toMatch(
          /^https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/,
        );
      } else if (href.startsWith("#")) {
        expect(html, href).toContain(`id="${href.slice(1)}"`);
      } else if (href.startsWith("/docs/")) {
        expect(findPage(href.slice("/docs/".length)), href).toBeDefined();
      } else if (href.startsWith("/canary")) {
        expect(existsSync(join(WEB, "src", "app", "canary", "page.tsx")), href).toBe(true);
      } else if (href.startsWith("/proof/")) {
        expect(href).toBe(`/proof/${demo.account}`);
      } else {
        throw new Error(`a link the test does not know: ${href}`);
      }
    }
  });

  it("opens a file or a transaction in a new tab, and a page of the site in this one", () => {
    for (const href of RECORD_LINKS) {
      const tags =
        html.match(
          new RegExp(`<a[^>]*href="${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`, "g"),
        ) ?? [];
      expect(tags.length, href).toBeGreaterThan(0);
      for (const tag of tags) {
        if (href.startsWith("https://")) expect(tag, href).toContain('target="_blank"');
        else expect(tag, href).not.toContain("target=");
      }
    }
    // The proof page is the site's own button, in this tab.
    expect(html).toMatch(
      /<a class="[^"]*"[^>]*href="\/proof\/demo\.vaults\.probarion\.testnet">Open the proof page <span aria-hidden="true">→<\/span><\/a>/,
    );
  });
});
