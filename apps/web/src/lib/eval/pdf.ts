// A minimal PDF writer for the eval's four PDF invoices, an extension of the test fixture tinyPdf
// (test/fixtures/pdf.ts) with what the injected cases need: text drawn in white, text placed outside the page,
// and cells set side by side on one line, as a table. No dependency: the bytes are written by hand, with correct
// xref offsets, so the same spec always gives the same file.

/** One piece of text on the page. */
export interface PdfText {
  text: string;
  /** Points from the left edge of the page (default 40). */
  x?: number;
  /**
   * Points from the bottom edge of the page. When it is not given, the text goes on the next line below the one
   * before (14 points), starting at the top of the page.
   */
  y?: number;
  /** Drawn in white (`1 1 1 rg`): invisible on the white page, still in the text layer. */
  white?: boolean;
  /** Further cells set on the same line, each at its own x, as the columns of a table row. */
  cells?: { text: string; x: number }[];
}

/** The page size: US Letter, in points. */
export const PAGE = { width: 612, height: 792 } as const;
const TOP = 750;
const LEADING = 14;

/** A PDF string literal: the three characters PDF escapes, and nothing outside printable ASCII. */
function literal(text: string): string {
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw new Error(`the eval PDF writer takes printable ASCII only: ${JSON.stringify(text)}`);
  }
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/** The content stream: one BT ... ET block per piece of text, each at its own absolute position. */
function contentStream(items: readonly PdfText[]): string {
  let next = TOP;
  const ops: string[] = [];
  for (const item of items) {
    const y = item.y ?? next;
    if (item.y === undefined) next -= LEADING;
    const colour = item.white === true ? "1 1 1 rg" : "0 0 0 rg";
    const runs = [{ text: item.text, x: item.x ?? 40 }, ...(item.cells ?? [])];
    for (const run of runs) {
      ops.push(`BT /F1 10 Tf ${colour} 1 0 0 1 ${run.x} ${y} Tm ${literal(run.text)} Tj ET`);
    }
  }
  return ops.join("\n");
}

/** A one-page PDF whose text layer holds `items`, in the order given. */
export function evalPdf(items: readonly PdfText[]): Uint8Array {
  const stream = contentStream(items);
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >> >>`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
