import { describe, expect, it } from "vitest";
import { extractFacts } from "./facts";

// W-T13-R2 (k): a property test of the amount reader. Random invoices are built from a small grammar: final total
// lines in readable formats, final total lines the reader must refuse (signs, brackets, other formats, other
// digits, dates, percents, ranges, other currencies, look-alike or hidden labels, counts), partial totals it must
// skip (sub, page, contract, year-to-date, installment) and noise lines. For every invoice the reader returns the
// one readable final total all of them agree on, or "0" with a reason: never any other figure.
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

type Line = { text: string; kind: "good"; units: string } | { text: string; kind: "bad" | "skip" };

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

  /** An amount: integer part and decimals, as strings (no leading zero), and its USDC units. */
  amount(): { whole: string; frac: string; units: string } {
    const size = this.pick([0, 1, 2, 3, 4, 6, 7, 9]);
    const whole = size === 0 ? "0" : String(this.int(10 ** (size - 1), 10 ** size - 1));
    const frac = this.digits(this.pick([0, 0, 1, 2, 2, 4, 5, 6]));
    const units = (BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0")).toString();
    return { whole, frac, units };
  }

  grouped(whole: string, sep: string): string {
    return whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  }

  /** A readable figure for an amount: plain, comma-grouped, or in full-width digits (NFKC reads them). */
  goodFigure(a: { whole: string; frac: string }): string {
    // A dot and exactly three decimals with no comma may be thousands (W-T13-R2 d): only grouped figures use it.
    const comma = a.whole.length > 3 && this.rnd() < 0.5;
    const frac = a.frac.length === 3 && !comma ? `${a.frac}0` : a.frac;
    const whole = comma ? this.grouped(a.whole, ",") : a.whole;
    const fig = frac === "" ? whole : `${whole}.${frac}`;
    if (this.rnd() < 0.15) {
      return [...fig]
        .map((c) => (/[0-9]/.test(c) ? String.fromCharCode(0xff10 + Number(c)) : c))
        .join("");
    }
    return fig;
  }

  label(): string {
    return this.pick([
      "Total",
      "TOTAL",
      "total",
      "Grand total",
      "Grand Total",
      "Total due",
      "Total amount due",
      "Total amount",
      "Amount due",
      "Balance due",
      "BALANCE DUE",
    ]);
  }
  sep(): string {
    return this.pick([" ", ": ", ":", "\t", " : ", ":  ", "\t\t"]);
  }

  good(): Line {
    const a = this.amount();
    const fig = this.goodFigure(a);
    const units = (BigInt(a.whole) * 1_000_000n + BigInt(a.frac.padEnd(6, "0") || "0")).toString();
    const pre = this.pick(["", "", "$", "$ ", "USDC ", "USD ", "US$"]);
    if (this.rnd() < 0.15) {
      // The figure alone on the next line.
      return {
        kind: "good",
        units,
        text: `${this.label()}:\n${pre}${fig}${this.pick(["", " USDC", " USD"])}`,
      };
    }
    const post = this.pick([
      "",
      "",
      " USDC",
      " USD",
      "USDC",
      " USDC (incl. VAT)",
      " USDC, thank you",
    ]);
    return { kind: "good", units, text: `${this.label()}${this.sep()}${pre}${fig}${post}` };
  }

  /** A figure in a format the reader must refuse. */
  badFigure(): string {
    const a = this.amount();
    const fig = this.goodFigure(a);
    const plain = a.frac === "" ? a.whole : `${a.whole}.${a.frac}`;
    const other = this.goodFigure(this.amount());
    const big = String(this.int(1000, 999_999_999));
    switch (this.int(0, 15)) {
      case 0:
        return `${this.pick(["-", "\u2212", "+", "(", "[", "- ", "\u2013 ", "\u2014"])}${fig}`;
      case 1:
        return this.pick([`(${fig})`, `-$${fig}`, `$-${fig}`, `USD -${fig}`, `${fig}-`]);
      case 2: // European: dots for thousands and a decimal comma
        return `${this.grouped(big, ".")},${this.digits(2)}`;
      case 3: // a dot and exactly three digits, no other separator
        return `${this.int(1, 999)}.${this.digits(3)}`;
      case 4: {
        const zero = this.pick([0x660, 0x6f0, 0x966, 0x9e6, 0xe50]);
        return [...plain]
          .map((c) => (/[0-9]/.test(c) ? String.fromCharCode(zero + Number(c)) : c))
          .join("");
      }
      case 5:
        return `${fig}${this.pick(["\u00b2", "\u00b3", "\u00b9", "\u2070", "\u2460"])}`;
      case 6: {
        const sep = this.pick([
          "\u2007",
          "\u2008",
          "\u200a",
          "\u3000",
          "\u2002",
          "'",
          "\u2019",
          "_",
          "\u00b7",
          "  ",
          " ",
          "\u00a0",
          "\u2009",
          "\u202f",
          ", ",
        ]);
        return this.grouped(big, sep);
      }
      case 7:
        return `${this.int(1, 99)},${this.digits(4)}`; // a 4-digit group
      case 8:
        return `${this.int(2000, 2099)}-${this.int(10, 12)}-${this.int(10, 28)}`;
      case 9:
        return this.pick([`${fig}%`, `${fig} %`, `${fig}\u2030`]);
      case 10:
        return this.pick([
          `${fig}-${other}`,
          `${fig}\u2013${other}`,
          `${fig} to ${other}`,
          `${fig}/month`,
        ]);
      case 11:
        return `${this.int(1, 12)}:${this.int(10, 59)}`;
      case 12:
        return this.pick([
          `${fig} EUR`,
          `€${fig}`,
          `GBP ${fig}`,
          `${fig} (EUR)`,
          `C$${fig}`,
          `${fig} BTC`,
        ]);
      case 13:
        return this.pick([
          `${fig} items`,
          `${fig} hours`,
          `${fig}k`,
          `${fig} USDC CR`,
          `${fig} USDC ${other}`,
        ]);
      case 14:
        return `${a.whole}.${this.digits(7)}`; // more decimals than USDC has
      default:
        return `${fig}\u200b${this.digits(3)}`; // a hidden character inside the figure
    }
  }

  bad(): Line {
    if (this.rnd() < 0.3) {
      // A readable figure under a label the reader must not trust.
      const a = this.amount();
      const fig = this.goodFigure(a);
      const label = this.pick([
        "\u0422otal",
        "T\u043etal",
        "\u03a4otal",
        "To\u200btal",
        "To\u00adtal",
        "To\u0336tal",
        "Tot\u00e1l",
        "T o t a l",
        "Tota1",
        "T0tal",
        "TotaI",
        "Arnount due",
        "Totals",
        "Grandtotal",
        "Total payable",
        "\u202eTotal",
      ]);
      return { kind: "bad", text: `${label}${this.sep()}${fig}${this.pick(["", " USDC"])}` };
    }
    return { kind: "bad", text: `${this.label()}${this.sep()}${this.badFigure()}` };
  }

  /** A partial or another document's total: skipped whatever its figure says. */
  partial(): Line {
    const label = this.pick([
      "Subtotal",
      "SUBTOTAL",
      "Sub-total",
      "Sub total",
      "Page total",
      "Contract total",
      "Year-to-date total",
      "YTD total",
      "Installment total",
      "Instalment total",
    ]);
    const fig = this.rnd() < 0.5 ? this.goodFigure(this.amount()) : this.badFigure();
    return { kind: "skip", text: `${label}${this.sep()}${fig}` };
  }

  noise(): Line {
    const n = this.int(1, 9999);
    return {
      kind: "skip",
      text: this.pick([
        `Invoice INV-${n}`,
        `Date: 2026-${this.int(10, 12)}-${this.int(10, 28)}`,
        `Due date: 2026-12-${this.int(10, 28)}`,
        "Tax 20%",
        `VAT (20%) ${this.goodFigure(this.amount())}`,
        `Qty ${this.int(1, 50)} items`,
        `Ref PO-${n}`,
        "Note: paid in 2 parts",
        `Range ${n}-${n + 100}`,
        "Rate 50 USDC/h",
        `Discount (${this.int(1, 99)})`,
        `Paid -${this.int(1, 500)} USDC`,
        "Pay to acme-design.near",
        "From: Acme Design LLC",
        `Hours ${this.int(1, 9)}.${this.digits(3)},${this.digits(2)}`,
        `Amount: ${this.goodFigure(this.amount())} USDC`,
        "Thank you for your business",
      ]),
    };
  }

  invoice(): Line[] {
    const lines: Line[] = [];
    const goods = this.pick([0, 1, 1, 1, 2, 2, 3]);
    // Agreeing totals most of the time: several final totals that say the same amount are one amount.
    const shared = this.good();
    for (let i = 0; i < goods; i++) lines.push(this.rnd() < 0.7 ? shared : this.good());
    const bads = this.rnd() < 0.5 ? 0 : this.int(1, 2);
    for (let i = 0; i < bads; i++) lines.push(this.bad());
    const others = this.int(0, 6);
    for (let i = 0; i < others; i++) lines.push(this.rnd() < 0.4 ? this.partial() : this.noise());
    // Shuffle (Fisher-Yates).
    for (let i = lines.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [lines[i], lines[j]] = [lines[j] as Line, lines[i] as Line];
    }
    return lines;
  }
}

describe(`extractFacts on ${CASES} random invoices (seed ${SEED})`, () => {
  it("returns the single agreeing readable final total, or 0 with a reason, never another figure", () => {
    const g = new Grammar(prng(SEED));
    const seen = { read: 0, refused: 0, ambiguous: 0, notFound: 0, zero: 0 };
    for (let n = 0; n < CASES; n++) {
      const lines = g.invoice();
      const text = lines.map((l) => l.text).join(g.pick(["\n", "\n", "\n\n"]));
      const f = extractFacts(text, H, null);
      const where = `seed ${SEED}, case ${n}: ${JSON.stringify(text)}`;
      const goods = new Set(lines.flatMap((l) => (l.kind === "good" ? [l.units] : [])));
      // Never any other figure: the amount is "0" or one of the readable final totals.
      expect(f.amount === "0" || goods.has(f.amount), where).toBe(true);
      if (f.amount === "0") expect(f.amountIssue, where).not.toBeNull();
      const [only, ...more] = [...goods];
      if (lines.some((l) => l.kind === "bad")) {
        expect(f.amount, where).toBe("0");
        seen.refused += 1;
      } else if (only === undefined) {
        expect({ amount: f.amount, issue: f.amountIssue }, where).toEqual({
          amount: "0",
          issue: "not_found",
        });
        seen.notFound += 1;
      } else if (more.length > 0) {
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
