// The landing's four real invoices (audit P1-5): every card is held to the demo vault's evidence in
// docs/evidence/demo-vault and its record in contracts/deployments/testnet.json, so the story cannot drift from
// what the chain and the signed ledger show.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import { explorerTxUrl } from "@/lib/config";
import { REPO_URL } from "@/lib/proof/cli";
import { JOURNEY, STORY } from "@/lib/site/facts";

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
  invoice_hash: string;
  proposal: unknown;
  rules: Rule[];
};
const ledgerLines = read(LEDGER).toString("utf8").trim().split("\n");
const ledger = ledgerLines.map((line) => (JSON.parse(line) as { body: Body }).body);
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

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
const linkOf = (card: (typeof STORY.invoices)[number], label: string) => {
  const found = card.links.find((l) => l.label === label);
  if (found === undefined) throw new Error(`${card.title}: no link "${label}"`);
  return found;
};
/** The ledger lines a link points at (`#L4` or `#L1-L3`), as the entries' seq numbers. */
const seqsOf = (url: string) => {
  const m = url.match(/#L(\d+)(?:-L(\d+))?$/);
  if (m === null) throw new Error(`not a line link: ${url}`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  return Array.from({ length: to - from + 1 }, (_, i) => ledger[from - 1 + i]?.seq);
};
const card = (title: string) => {
  const found = STORY.invoices.find((c) => c.title === title);
  if (found === undefined) throw new Error(`no card ${title}`);
  return found;
};

describe("the journey's four invoices on the testnet demo vault (audit P1-5)", () => {
  it("says who sent them, in the words the audit asks for", () => {
    expect(STORY.caption).toBe("Invoices we sent to our own demo vault on NEAR testnet.");
    expect(STORY.title).toBe("Four invoices on the testnet demo vault");
  });

  it("closes the journey section, after its five steps, with the proof page link", () => {
    const html = renderToStaticMarkup(createElement(Home));
    // The journey nests the steps' scroll regions, which are sections too, so it ends where Integrate begins.
    const section = html.slice(html.indexOf('id="payment"'), html.indexOf('id="integrate"'));
    expect(html.indexOf('id="integrate"')).toBeGreaterThan(html.indexOf('id="payment"'));
    const lastStep = text(section).lastIndexOf(JOURNEY.steps[4]?.title ?? "missing");
    const story = text(section).indexOf(STORY.title);
    expect(lastStep).toBeGreaterThan(0);
    expect(story).toBeGreaterThan(lastStep);
    for (const words of [STORY.caption, ...STORY.invoices.flatMap((c) => [c.title, c.pill])]) {
      expect(text(section)).toContain(words);
    }
    expect(section).toContain(`href="${STORY.proof.href}"`);
    expect(STORY.proof.href).toBe(`/proof/${demo.account}`);
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

  it("links each invoice card to the exact file the chain hashed", () => {
    for (const c of STORY.invoices) {
      if (c.title.includes("again")) continue;
      const path = `${EVIDENCE}/invoice-${c.invoice}.txt`;
      expect(linkOf(c, "Invoice").url, c.title).toBe(`${REPO_URL}/blob/main/${path}`);
      expect(read(path).toString("utf8"), c.title).toContain(`Invoice ${c.invoice}`);
    }
    expect(read(`${EVIDENCE}/invoice-INV-2002.txt`).toString("utf8")).toContain(
      "We changed banks.",
    );
  });

  it("links every ledger entry of an invoice, and only that invoice's entries", () => {
    for (const c of STORY.invoices) {
      const ledgerLink = c.links.find((l) => l.label.startsWith("Ledger"));
      if (ledgerLink === undefined) continue;
      expect(ledgerLink.url.startsWith(`${REPO_URL}/blob/main/${LEDGER}#L`), c.title).toBe(true);
      const hash = sha256(`${EVIDENCE}/invoice-${c.invoice}.txt`);
      expect(seqsOf(ledgerLink.url), c.title).toEqual(
        ledger.filter((e) => e.invoice_hash === hash).map((e) => e.seq),
      );
      const seqs = seqsOf(ledgerLink.url);
      const label =
        seqs.length === 1
          ? `Ledger entry ${seqs[0]}`
          : `Ledger entries ${seqs[0]} to ${seqs.at(-1)}`;
      expect(ledgerLink.label, c.title).toBe(label);
    }
  });

  it("pays INV-2001 with spend 1, the transaction the deployment record names", () => {
    const paid = card("INV-2001");
    const spend = demo.spends.find((s) => s.id === 1);
    expect(spend?.invoice).toBe("INV-2001");
    expect(spend?.amount).toBe("2000000");
    expect(paid.pill).toBe("Paid");
    expect(paid.asks).toBe("2 test USDC to the mandate's payee");
    const tx = linkOf(paid, "Tx HFyW61UZ…dQp1");
    expect(tx.url).toBe(explorerTxUrl("testnet", spend?.spend_tx ?? ""));
  });

  it("refuses the same file again on upload, in the console's own words, with nothing in the ledger", () => {
    const again = card("INV-2001, sent again");
    expect(again.invoice).toBe("INV-2001");
    expect(again.pill).toBe("Refused on upload");
    expect(again.links).toEqual([]);
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
    expect(changed.pill).toBe("Refused by code");
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
  });

  it("holds INV-2003 above the approval limit, then pays it on the approver's approval", () => {
    const held = card("INV-2003");
    const spend = demo.spends.find((s) => s.id === 2);
    expect(spend?.invoice).toBe("INV-2003");
    expect(spend?.amount).toBe("4000000");
    expect(held.pill).toBe("Held, then paid");
    expect(held.asks).toBe("4 test USDC, above the 3 USDC approval limit");
    expect(linkOf(held, "Held 6oDNZEUB…y2Tb").url).toBe(
      explorerTxUrl("testnet", spend?.spend_tx ?? ""),
    );
    expect(linkOf(held, "Approved 47VCARhw…NCJf").url).toBe(
      explorerTxUrl("testnet", spend?.approve_tx ?? ""),
    );
  });

  it("shortens each transaction hash to its first 8 and last 4 characters", () => {
    for (const c of STORY.invoices) {
      for (const l of c.links) {
        const hash = l.url.match(/\/txns\/([1-9A-HJ-NP-Za-km-z]+)$/)?.[1];
        if (hash === undefined) continue;
        expect(l.label, c.title).toMatch(new RegExp(`${hash.slice(0, 8)}…${hash.slice(-4)}$`));
      }
    }
  });
});
