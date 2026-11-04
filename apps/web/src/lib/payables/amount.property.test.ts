import { describe, expect, it } from "vitest";
import { extractFacts } from "./facts";

// A property test of the invoice amount reader. Random invoices are built from a grammar:
//   - readable final-total lines (labels, prefixes, infixes, separators, amount forms, tails);
//   - final-total lines and documents the reader must refuse: signs, other formats and digits, look-alike or
//     hidden labels, trailers after the amount, a label whose figure is in a column block or split across lines,
//     a document type, a status stamp, another currency anywhere, a second invoice, a NUL or a bidi control;
//   - partial and payment lines (subtotal, tax, shipping, discount, amount paid, ...), which never pay;
//   - noise: line items, notes, terms, payees.
// For every invoice the reader returns the one readable final total all final lines agree on, or "0" with a
// reason: never any other figure.
//
// Reproduce a failure with FACTS_PROPERTY_SEED=<seed> (the failure message names the seed and the case).

const SEED = Number(process.env.FACTS_PROPERTY_SEED ?? 20261104);
const CASES = 3000;
const H = "c".repeat(64);

/** mulberry32: a small seeded PRNG, so a failing case can be reproduced exactly. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A line of the invoice and what the reader must make of it. */
type Line =
  | { text: string; kind: "final"; key: string; balance: boolean; units: string }
  | { text: string; kind: "bad" }
  /** `deduct`: a non-zero payment, deposit, credit or carried balance, after which a plain Total is not due. */
  | { text: string; kind: "skip"; deduct?: boolean };

/** The deduction labels of the partial lines below. */
const DEDUCTIONS = new Set([
  "Deposit paid",
  "Amount paid",
  "Payment received",
  "Credit applied",
  "Previous balance",
]);

const LABELS = [
  "Total",
  "TOTAL",
  "Total due",
  "Total amount",
  "Total amount due",
  "Total payable",
  "Amount due",
  "Amount payable",
  "Balance due",
  "Balance remaining",
  "Amount remaining",
  "Amount owing",
  "Total owing",
  "Outstanding balance",
];
const PREFIXES = ["", "", "", "Invoice ", "Order ", "Grand ", "Final "];
const SEPS = [" ", ": ", ":", "\t", " : ", " = ", " | ", " ........ "];

class Grammar {
  constructor(private readonly rnd: () => number) {}

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.rnd() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)] as T;
  }
  digits(n: number): string {
    let s = "";
    for (let i = 0; i < n; i++) s += String(this.int(0, 9));
    return s;
  }

  /** An amount: integer part and decimals (no leading zero), and its USDC base units. */
  amount(): { whole: string; frac: string; units: string } {
    const size = this.pick([0, 1, 2, 3, 4, 6, 7, 9]);
    const whole = size === 0 ? "0" : String(this.int(10 ** (size - 1), 10 ** size - 1));
    const frac = this.digits(this.pick([0, 0, 1, 2, 2, 2, 4, 6]));
    const units = (BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0")).toString();
    return { whole, frac, units };
  }
  grouped(whole: string, sep: string): string {
    return whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  }
  /** A figure the grammar reads: plain or US-grouped digits (sometimes full-width), up to 6 decimals. */
  figure(a: { whole: string; frac: string }): string {
    const whole = a.whole.length > 3 && this.rnd() < 0.5 ? this.grouped(a.whole, ",") : a.whole;
    const fig = a.frac === "" ? whole : `${whole}.${a.frac}`;
    if (this.rnd() < 0.1) {
      return [...fig]
        .map((c) => (/[0-9]/.test(c) ? String.fromCharCode(0xff10 + Number(c)) : c))
        .join("");
    }
    return fig;
  }
  /** The figure with a currency marker, in one of the allowed forms; `code`: it ends with a currency code. */
  marked(fig: string): { text: string; code: boolean } {
    switch (this.int(0, 7)) {
      case 0:
        return { text: `$${fig}`, code: false };
      case 1:
        return { text: `US$${fig}`, code: false };
      case 2:
        return { text: `USD ${fig}`, code: false };
      case 3:
        return { text: `USDC ${fig}`, code: false };
      case 4:
        return { text: `${fig} USD`, code: true };
      case 5:
        return { text: `${fig} USDC`, code: true };
      case 6:
        return { text: `$${fig} USD`, code: true };
      default:
        return { text: `$${fig} USDC`, code: true };
    }
  }

  final(): Line {
    const a = this.amount();
    const label = this.pick(LABELS);
    const prefix = this.pick(PREFIXES);
    const key = `${prefix}${label}`.toLowerCase().replace(/\s+/g, " ").trim();
    const infix = this.pick(["", "", "", " (USD)", " (USDC)", " in USD"]);
    const m = this.marked(this.figure(a));
    // After a currency infix the figure may stand without its own marker.
    const bare = infix !== "" && this.rnd() < 0.3;
    const amount = bare ? this.figure(a) : m.text;
    const tails = ["", "", "", " (incl. VAT)", " (including tax)", " (net 30)", ", thank you"];
    if (m.code && !bare) tails.push(".", ",");
    return {
      kind: "final",
      key,
      // Every label but a plain total states what is left to pay after deductions.
      balance: !/^total( amount)?$/i.test(label),
      units: a.units,
      text: `${prefix}${label}${infix}${this.pick(SEPS)}${amount}${this.pick(tails)}`,
    };
  }

  /** A final-total line or a document the reader must refuse. */
  bad(): Line {
    const a = this.amount();
    const fig = this.figure(a);
    const label = this.pick(LABELS);
    const sep = this.pick(SEPS);
    const big = String(this.int(1000, 999_999_999));
    const text = ((): string => {
      switch (this.int(0, 21)) {
        case 0: // a sign or a bracket
          return `${label}${sep}${this.pick(["-", "\u2212", "+", "(", "- ", "\u2013 "])}$${fig}`;
        case 1: // no currency marker
          return `${label}${sep}${fig}`;
        case 2: // a European figure, or a dot and three digits
          return `${label}${sep}${this.pick([`${this.grouped(big, ".")},${this.digits(2)}`, `${this.int(1, 999)}.${this.digits(3)}`])} USDC`;
        case 3: // other digits, or a superscript after the figure
          return `${label}${sep}${this.pick([[...a.whole].map((c) => String.fromCharCode(0x660 + Number(c))).join(""), `${fig}\u00b2`])} USDC`;
        case 4: // a grouping separator the grammar does not read
          return `${label}${sep}$${this.grouped(big, this.pick(["\u2007", "\u3000", "'", "_", "\u00b7", "  ", " ", ", "]))}`;
        case 5: // a trailer after the amount
          return `${label}${sep}${fig} USDC ${this.pick(["paid on 2026-10-30", "refunded", "per hour", "(approx. 92)", "/ month", "cents", "million", "20%", "200 USDC", "CR"])}`;
        case 6: // a qualifier or a word before the label
          return `${this.pick(["Estimated", "Refund", "Credit", "Hours", "Project", "See page 2", ">"])} ${label.toLowerCase()}${sep}$${fig}`;
        case 7: // a look-alike or hidden label
          return `${this.pick(["\u0422otal", "T\u00f8tal", "Tota\u0142", "T\u0966tal", "Tota1", "T0tal", "To\u200btal", "To\u0336tal", "\u1d1b\u1d0f\u1d1b\u1d00\u029f", "Totals", "Grandtotal", "Am\u0966unt due"])}${sep}$${fig}`;
        case 8: // a label with its figure in a column block
          return `${label}\n$${fig}`;
        case 9: // a figure split across two lines
          return `${label}${sep}$1,\n${this.digits(3)}.00`;
        case 10: // a label with no figure
          return this.pick([`${label} upon receipt`, `${label}:`, label]);
        case 11: // another document type
          return this.pick([
            "RECEIPT",
            "Remittance advice",
            "QUOTATION Q-12",
            "Estimate",
            "Credit note CN-4",
            "Refund",
            "Statement of account",
            "Pro forma",
            "Debit note",
          ]);
        case 12: // a status stamp
          return this.pick([
            "VOID",
            "*** PAID ***",
            "Status: Paid",
            "Do not pay",
            "SAMPLE",
            "CANCELLED",
            "This is not an invoice.",
          ]);
        case 13: // another currency, anywhere
          return this.pick([
            "Prices in EUR",
            "Currency: GBP",
            "Total in yen",
            "€ accepted",
            "Pay in C$",
            "or 25 NEAR",
            "Rates in pounds",
          ]);
        case 14: // a second invoice
          return `Invoice INV-${this.int(9000, 9499)}\nInvoice INV-${this.int(9500, 9999)}`;
        case 15: // a NUL inside the figure
          return `${label}${sep}$${a.whole}\u0000${this.digits(2)}`;
        case 16: // a bidi control
          return `\u202e${label}${sep}$${fig}`;
        case 17: // more decimals than USDC has
          return `${label}${sep}$${a.whole}.${this.digits(7)}`;
        case 18: // a payable word with a figure, outside both grammars
          return this.pick([`Balance: $${fig}`, `Amount: ${fig} USDC`, `Outstanding ${fig} USDC`]);
        case 19: // more than 10^12 USDC
          return `${label}${sep}$${this.int(1, 9)}${this.digits(12)}.01`;
        case 20: // a tail that is not allowed
          return `${label}${sep}$${fig} (incl. ${this.pick(["thousands", "refund", "20% VAT"])})`;
        default: // a full stop right after a dollar figure
          return `${label}${sep}$${fig}.`;
      }
    })();
    return { kind: "bad", text };
  }

  /** A partial or payment line, which never pays. */
  partial(): Line {
    const fig = this.figure(this.amount());
    const label = this.pick([
      "Subtotal",
      "Sub-total",
      "Tax",
      "Tax (10%)",
      "VAT 20%",
      "Sales tax 8.25%",
      "Shipping",
      "Handling",
      "Discount",
      "Fee",
      "Deposit paid",
      "Amount paid",
      "Payment received",
      "Credit applied",
      "Previous balance",
      "Page total",
      "Net total",
      "Installment 2 of 3",
    ]);
    const amount = this.pick([`$${fig}`, `${fig} USDC`, fig, `-$${fig}`]);
    return {
      kind: "skip",
      text: `${label}${this.pick([" ", ": ", "\t"])}${amount}`,
      deduct: DEDUCTIONS.has(label) && /[1-9]/.test(fig.normalize("NFKC")),
    };
  }

  noise(): Line {
    const fig = this.figure(this.amount());
    return {
      kind: "skip",
      text: this.pick([
        `Logo design $${fig}`,
        `Consulting, 10 hours ${fig} USDC`,
        "From: Acme Design LLC",
        "Bill to: Globex Corp",
        "Invoice date: 2026-11-04",
        "Due date: 2026-12-01",
        "Payment due within 30 days",
        "Payment terms: Net 30",
        "Pay to acme-design.near",
        "PO: PO-4471",
        "Thank you for your business",
        "Late payments incur a 1.5% monthly fee.",
        "Item Qty Price Total",
        `Vendor: \u682a\u5f0f\u4f1a\u793eABC ${this.int(1, 9999)}`,
      ]),
    };
  }

  invoice(): { text: string; lines: Line[] } {
    const body: Line[] = [];
    const finals = this.pick([0, 1, 1, 1, 1, 2, 2]);
    const shared = this.final();
    for (let i = 0; i < finals; i++) body.push(this.rnd() < 0.6 ? shared : this.final());
    const bads = this.rnd() < 0.5 ? 0 : this.int(1, 2);
    for (let i = 0; i < bads; i++) body.push(this.bad());
    const others = this.int(0, 7);
    for (let i = 0; i < others; i++) body.push(this.rnd() < 0.4 ? this.partial() : this.noise());
    for (let i = body.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [body[i], body[j]] = [body[j] as Line, body[i] as Line];
    }
    const title: Line = {
      kind: "skip",
      text: this.pick(["INVOICE", "Invoice INV-2026-07", "Tax invoice"]),
    };
    const lines = [title, ...body];
    return { text: lines.map((l) => l.text).join(this.pick(["\n", "\n", "\n\n"])), lines };
  }
}

describe(`extractFacts on ${CASES} random invoices (seed ${SEED})`, () => {
  it("returns the single agreed readable final total, or 0 with a reason, never another figure", () => {
    const g = new Grammar(prng(SEED));
    const seen = { read: 0, refused: 0, ambiguous: 0, notFound: 0, zero: 0 };
    for (let n = 0; n < CASES; n++) {
      const { text, lines } = g.invoice();
      const f = extractFacts(text, H, null);
      const where = `seed ${SEED}, case ${n}: ${JSON.stringify(text)}`;
      const finals = lines.flatMap((l) => (l.kind === "final" ? [l] : []));
      const values = new Set(finals.map((l) => l.units));
      const keys = new Set(finals.map((l) => l.key));
      // Never any other figure: the amount is "0", or one of the readable final totals.
      expect(f.amount === "0" || values.has(f.amount), where).toBe(true);
      if (f.amount === "0") expect(f.amountIssue, where).not.toBeNull();
      const [only, ...more] = [...values];
      if (lines.some((l) => l.kind === "bad")) {
        expect(f.amount, where).toBe("0");
        seen.refused += 1;
      } else if (only === undefined) {
        expect({ amount: f.amount, issue: f.amountIssue }, where).toEqual({
          amount: "0",
          issue: "not_found",
        });
        seen.notFound += 1;
      } else if (
        more.length > 0 ||
        keys.size < finals.length ||
        (lines.some((l) => l.kind === "skip" && l.deduct) && !finals.some((l) => l.balance))
      ) {
        // Totals that disagree, the same final label twice (two documents), or a plain Total before a deduction.
        expect({ amount: f.amount, issue: f.amountIssue }, where).toEqual({
          amount: "0",
          issue: "ambiguous",
        });
        seen.ambiguous += 1;
      } else if (only === "0") {
        expect({ amount: f.amount, issue: f.amountIssue }, where).toEqual({
          amount: "0",
          issue: "zero",
        });
        seen.zero += 1;
      } else {
        expect({ amount: f.amount, issue: f.amountIssue }, where).toEqual({
          amount: only,
          issue: null,
        });
        seen.read += 1;
      }
    }
    // The grammar reaches every outcome, so the property is not met vacuously.
    for (const [outcome, count] of Object.entries(seen)) expect(count, outcome).toBeGreaterThan(0);
  });
});
