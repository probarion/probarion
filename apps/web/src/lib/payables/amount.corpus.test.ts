import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractFacts } from "./facts";

// Two corpora for the invoice amount reader, both through the public extractFacts:
//   - the regression corpus (test/fixtures/amount-corpus.json): every input of the adversarial sweep and of the
//     re-reviews, each with the result it must give;
//   - the positive corpus below: plain invoices that must read the right amount, so a reader that refuses
//     everything fails.

const H = "c".repeat(64);
const read = (text: string) => {
  const f = extractFacts(text, H, null);
  return { amount: f.amount, issue: f.amountIssue };
};

type Part = { text: string; repeat?: number; slice?: number };
interface Case {
  id: string;
  source: string;
  text?: string;
  build?: { parts: Part[]; slice?: number };
  expect: { amount: string; issue: string | null };
  why?: string;
}

const corpus = JSON.parse(
  readFileSync(new URL("../../../test/fixtures/amount-corpus.json", import.meta.url), "utf8"),
) as { cases: Case[] };

function textOf(c: Case): string {
  if (c.text !== undefined) return c.text;
  const parts = (c.build?.parts ?? []).map((p) => {
    const t = p.text.repeat(p.repeat ?? 1);
    return p.slice === undefined ? t : t.slice(0, p.slice);
  });
  const joined = parts.join("");
  return c.build?.slice === undefined ? joined : joined.slice(0, c.build.slice);
}

describe("the regression corpus", () => {
  it("holds every input of the sweep and of the re-reviews", () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(850);
    for (let n = 1; n <= 19; n++) {
      expect(corpus.cases.some((c) => c.id.startsWith(`sweep-${n}.`))).toBe(true);
    }
    // The third re-review: the inputs of its 15 open findings, its probes and its widening probes.
    for (let n = 1; n <= 15; n++) {
      expect(corpus.cases.some((c) => c.id.startsWith(`r4-open-${n}.`))).toBe(true);
    }
    expect(corpus.cases.filter((c) => c.id.startsWith("r4-p")).length).toBeGreaterThan(200);
    expect(corpus.cases.filter((c) => c.id.startsWith("r4-widen-")).length).toBeGreaterThan(100);
    // The fourth re-review: the inputs of its open findings on the reader (3 to 12) and the judge's probes. Each
    // input the invoice-title gate now refuses has a twin with a title, which keeps its earlier result.
    for (let n = 3; n <= 12; n++) {
      expect(corpus.cases.some((c) => c.id.startsWith(`r5-open-${n}.`))).toBe(true);
    }
    expect(corpus.cases.filter((c) => /^r5-p[a-z]+\./.test(c.id)).length).toBeGreaterThan(250);
    const titled = corpus.cases.filter((c) => c.id.endsWith(".titled"));
    expect(titled.length).toBeGreaterThan(40);
    for (const t of titled) expect(corpus.cases.some((c) => `${c.id}.titled` === t.id)).toBe(true);
    // The final re-review: the judge's probe groups S1 to S14 for the breaker rulings.
    for (let n = 1; n <= 14; n++) {
      expect(corpus.cases.some((c) => c.id.startsWith(`r6-S${n}.`))).toBe(true);
    }
    expect(corpus.cases.filter((c) => c.id.startsWith("r6-")).length).toBeGreaterThan(280);
  });

  it.each(corpus.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    expect(read(textOf(c)), c.why).toEqual(c.expect);
  });
});

/**
 * Realistic USD and USDC invoices, as the text layers of common tools export them (cells joined by tabs, a page
 * footer per page). Each states what a careful person pays; the reader pays exactly that, or refuses with a reason.
 */
const layouts = JSON.parse(
  readFileSync(new URL("../../../test/fixtures/invoice-layouts.json", import.meta.url), "utf8"),
) as { cases: { id: string; pays: string; text: string; expect: Case["expect"] }[] };

describe("realistic invoice layouts", () => {
  it.each(layouts.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const got = read(c.text);
    expect(got).toEqual(c.expect);
    // Never another figure: the amount a careful person pays, or "0" with a reason.
    expect(
      got.amount === "0" ? got.issue !== null : got.amount === c.pays && got.issue === null,
    ).toBe(true);
  });

  it("reads at least 35 of the 49 layouts, and pays none of them a wrong amount", () => {
    const results = layouts.cases.map((c) => ({ c, got: read(c.text) }));
    expect(layouts.cases).toHaveLength(49);
    expect(results.filter(({ c, got }) => got.amount === c.pays).length).toBeGreaterThanOrEqual(35);
    expect(results.filter(({ c, got }) => got.amount !== "0" && got.amount !== c.pays)).toEqual([]);
  });
});

/**
 * Seventy invoices written fresh for the fourth re-review (48 a careful person pays, 22 they refuse). The reader
 * pays exactly what a careful person pays, or refuses with a reason; the quotation R04 (its type only as a
 * "Quotation No.:" field on line 7) refuses.
 */
const fresh = JSON.parse(
  readFileSync(new URL("../../../test/fixtures/fresh-invoices.json", import.meta.url), "utf8"),
) as {
  cases: {
    id: string;
    kind: "pay" | "refuse";
    pays: string;
    text: string;
    expect: Case["expect"];
  }[];
};

describe("the fresh corpus", () => {
  it.each(fresh.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const got = read(c.text);
    expect(got).toEqual(c.expect);
    expect(
      got.amount === "0"
        ? got.issue !== null
        : c.kind === "pay" && got.amount === c.pays && got.issue === null,
    ).toBe(true);
  });

  it("reads at least 24 of the 48 payable invoices, refuses all 22 others, and pays none a wrong amount", () => {
    expect(fresh.cases).toHaveLength(70);
    const results = fresh.cases.map((c) => ({ c, got: read(c.text) }));
    const payable = results.filter(({ c }) => c.kind === "pay");
    expect(payable).toHaveLength(48);
    expect(payable.filter(({ c, got }) => got.amount === c.pays).length).toBeGreaterThanOrEqual(24);
    expect(results.filter(({ c, got }) => c.kind === "refuse" && got.amount !== "0")).toEqual([]);
    expect(results.filter(({ c, got }) => got.amount !== "0" && got.amount !== c.pays)).toEqual([]);
    expect(results.find(({ c }) => c.id === "R04")?.got).toEqual({
      amount: "0",
      issue: "not_payable",
    });
  });
});

/**
 * A second fresh corpus, written for the final re-review: corpus5 (35 invoices a careful person pays, 21 they
 * refuse) and corpus5b (realistic traps: 19 and 26). The reader pays exactly what a careful person pays, or refuses.
 */
const fresh2 = JSON.parse(
  readFileSync(new URL("../../../test/fixtures/fresh-invoices-2.json", import.meta.url), "utf8"),
) as {
  cases: {
    id: string;
    set: "corpus5" | "corpus5b";
    kind: "pay" | "refuse";
    pays: string;
    text: string;
    expect: Case["expect"];
  }[];
};

describe("the second fresh corpus", () => {
  it.each(fresh2.cases.map((c) => [`${c.set} ${c.id}`, c] as const))("%s", (_id, c) => {
    const got = read(c.text);
    expect(got).toEqual(c.expect);
    expect(
      got.amount === "0"
        ? got.issue !== null
        : c.kind === "pay" && got.amount === c.pays && got.issue === null,
    ).toBe(true);
  });

  it.each([
    ["corpus5", 56, 35, 18],
    ["corpus5b", 45, 19, 3],
  ] as const)(
    "%s: %i documents; reads at least the floor of its %i payable ones (%i), refuses the rest, pays none a wrong amount",
    (set, total, payable, floor) => {
      const results = fresh2.cases
        .filter((c) => c.set === set)
        .map((c) => ({ c, got: read(c.text) }));
      expect(results).toHaveLength(total);
      const pay = results.filter(({ c }) => c.kind === "pay");
      expect(pay).toHaveLength(payable);
      expect(pay.filter(({ c, got }) => got.amount === c.pays).length).toBeGreaterThanOrEqual(
        floor,
      );
      expect(results.filter(({ c, got }) => c.kind === "refuse" && got.amount !== "0")).toEqual([]);
      expect(results.filter(({ c, got }) => got.amount !== "0" && got.amount !== c.pays)).toEqual(
        [],
      );
    },
  );
});

/** A plain invoice: header, items, partial lines, the final line(s), notes and terms. */
const invoice = (lines: string[]) => lines.join("\n");

const POSITIVE: [string, string, string][] = [
  [
    "a dollar total after subtotal and tax",
    invoice([
      "INVOICE",
      "From: Acme Design LLC",
      "Invoice # INV-2026-071",
      "Invoice date: 2026-11-04",
      "Bill to: Globex Corp",
      "Description Qty Unit price Amount",
      "Logo design 1 $700.00 $700.00",
      "Brand guide 1 $480.00 $480.00",
      "Subtotal: $1,180.00",
      "Tax (6%): $70.50",
      "Total: $1,250.50",
      "Payment terms: Net 30",
      "Thank you for your business!",
    ]),
    "1250500000",
  ],
  [
    "an amount due in USDC with a PO and a payee",
    invoice([
      "Invoice INV-2026-072",
      "PO: PO-4471",
      "Website maintenance, October $1,250.50",
      "Subtotal 1,250.50",
      "Amount due: 1,250.50 USDC",
      "Pay to acme-design.near",
      "Due date: 2026-12-01",
    ]),
    "1250500000",
  ],
  [
    "a code before the figure, in capitals",
    invoice([
      "TAX INVOICE",
      "INVOICE NO. 3310",
      "ITEM QTY PRICE TOTAL",
      "HOSTING 12 MONTHS 50.00 600.00",
      "SETUP 1 100.00 100.00",
      "SUBTOTAL USD 700.00",
      "VAT 10% USD 70.00",
      "TOTAL USD 770.00",
    ]),
    "770000000",
  ],
  [
    "a balance due with an infix, after a deposit",
    invoice([
      "Invoice INV-2026-073",
      "Event photography $700.00",
      "Subtotal $700.00",
      "Tax $70.00",
      "Deposit paid $670.00",
      "Balance due (USD): $100.00",
      "Payment due within 14 days",
    ]),
    "100000000",
  ],
  [
    "a grand total in USDC",
    invoice([
      "Invoice INV-2026-074",
      "Consulting, 60 hours at 150.00 USDC 9,000.00 USDC",
      "Subtotal 9,000.00 USDC",
      "Discount 0.00 USDC",
      "Grand total 9,000.00 USDC",
      "Terms: Net 15",
    ]),
    "9000000000",
  ],
  [
    "six decimals",
    invoice(["Invoice INV-2026-075", "API usage 2.000000 USDC", "Total due 2.000000 USDC"]),
    "2000000",
  ],
  [
    "two final labels that agree",
    invoice([
      "Invoice INV-2026-076",
      "Logo design $1,250.50",
      "Total: $1,250.50",
      "Amount paid: $0.00",
      "Amount due: $1,250.50",
    ]),
    "1250500000",
  ],
  [
    "an invoice total with an infix and no marker on the figure",
    invoice([
      "Invoice INV-2026-077",
      "Copywriting 2,000.00",
      "Subtotal (USD): 2,000.00",
      "Total in USD: 2,000.00",
      "Remit to: Acme LLC, 123 Main St, Springfield 62701",
    ]),
    "2000000000",
  ],
  [
    "dot leaders",
    invoice([
      "Invoice INV-2026-078",
      "Logo design ......... $700.00",
      "Subtotal ............ $700.00",
      "Tax ................. $70.00",
      "Total ............... $770.00",
    ]),
    "770000000",
  ],
  [
    "a Markdown table",
    invoice([
      "Invoice INV-2026-079",
      "| Item | Price |",
      "| Logo design | $700.00 |",
      "| Subtotal | $700.00 |",
      "| Tax | $70.00 |",
      "| Total | $770.00 |",
    ]),
    "770000000",
  ],
  [
    "a tab-separated table with a header row",
    invoice([
      "Invoice INV-2026-080",
      "#\tItem\tQty\tPrice\tTotal",
      "1\tLogo design\t1\t400.00\t400.00",
      "2\tBrand guide\t2\t150.00\t300.00",
      "Subtotal\t700.00",
      "Total\t700.00 USDC",
    ]),
    "700000000",
  ],
  [
    "a tail that says what the total includes",
    invoice([
      "Invoice INV-2026-081",
      "Translation, 4,000 words $420.00",
      "VAT 20% $70.00",
      "Balance due $420.00 (incl. VAT)",
    ]),
    "420000000",
  ],
  [
    "a thank-you tail",
    invoice([
      "Invoice INV-2026-082",
      "Office chairs, 4 x 275.00 USDC 1,100.00 USDC",
      "Shipping 0.00 USDC",
      "Total due 1,100.00 USDC, thank you",
    ]),
    "1100000000",
  ],
  [
    "a net-terms tail",
    invoice(["Invoice INV-2026-083", "Domain renewal $99.99", "Total: $99.99 (net 30)"]),
    "99990000",
  ],
  [
    "an order total with an equals sign",
    invoice([
      "Acme Office Supply",
      "Invoice INV-2026-084",
      "Printer paper, 10 boxes $310.40",
      "Order total = $310.40",
    ]),
    "310400000",
  ],
  [
    "a final amount due in US$",
    invoice([
      "Invoice INV-2026-085",
      "Annual licence US$ 5,000.00",
      "Handling US$ 0.00",
      "Final amount due: US$ 5,000.00",
    ]),
    "5000000000",
  ],
  [
    "an outstanding balance",
    invoice([
      "Invoice INV-2026-086",
      "Previous balance $0.00",
      "Gardening, November $230.00",
      "Outstanding balance: $230.00",
    ]),
    "230000000",
  ],
  [
    "an amount owing with a credit applied",
    invoice([
      "Invoice INV-2026-087",
      "Support plan 100.00 USDC",
      "Credit applied 24.50 USDC",
      "Amount owing 75.50 USDC",
    ]),
    "75500000",
  ],
  [
    "a total payable over a page total",
    invoice([
      "Invoice INV-2026-088",
      "Server racks, 3 x $4,115.22 $12,345.66",
      "Page total $12,345.66",
      "Fees $0.01",
      "Total payable: $12,345.67",
    ]),
    "12345670000",
  ],
  [
    "a balance remaining after a payment",
    invoice([
      "Invoice INV-2026-089",
      "Development sprint 1,500 USDC",
      "Payment received 500 USDC",
      "Balance remaining: 1,000 USDC",
    ]),
    "1000000000",
  ],
  [
    "please pay",
    invoice(["Invoice INV-2026-090", "Window cleaning $64.00", "Please pay: $64.00"]),
    "64000000",
  ],
  [
    "pay this amount",
    invoice(["Invoice INV-2026-091", "Tutoring, 2 sessions $128.00", "Pay this amount: $128.00"]),
    "128000000",
  ],
  [
    "total to pay in USDC",
    invoice(["Invoice INV-2026-092", "Illustration 450 USDC", "Total to pay: 450 USDC"]),
    "450000000",
  ],
  [
    "an invoice total with a dollar figure followed by its code",
    invoice([
      "Invoice INV-2026-093",
      "Audit $3,000.00",
      "Sales tax 8.25% $247.50",
      "Invoice total: $3,247.50 USD",
    ]),
    "3247500000",
  ],
  [
    "a code before the figure, in mixed case",
    invoice(["Invoice INV-2026-094", "Video edit 800.00", "Amount payable: USDC 800.00"]),
    "800000000",
  ],
  [
    "a full-width figure (NFKC reads the digits it shows)",
    invoice([
      "Invoice INV-2026-095",
      "Hosting \uff15\uff10\uff10.00 USDC",
      "Total \uff15\uff10\uff10.00 USDC",
    ]),
    "500000000",
  ],
  [
    "a vendor name in another script",
    invoice([
      "Vendor: \u682a\u5f0f\u4f1a\u793eABC 2026",
      "Invoice INV-2026-096",
      "Bill to: Acme Corp",
      "Components 1,000.00 USDC",
      "Total 1,000.00 USDC",
    ]),
    "1000000000",
  ],
  [
    "a total of a cent, with notes",
    invoice([
      "Invoice INV-2026-097",
      "Test transfer $0.01",
      "Total: $0.01",
      "Questions? Write to billing@acme.test",
      "Late payments incur a 1.5% monthly fee.",
    ]),
    "10000",
  ],
];

describe("the positive corpus: plain invoices read the right amount", () => {
  it("has at least 25 layouts", () => {
    expect(POSITIVE.length).toBeGreaterThanOrEqual(25);
  });

  it.each(POSITIVE)("reads %s", (_name, text, amount) => {
    expect(read(text)).toEqual({ amount, issue: null });
  });
});
