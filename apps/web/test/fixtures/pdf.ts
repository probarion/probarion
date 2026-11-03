/**
 * Builds a minimal, valid PDF with correct xref offsets: `pages` pages (default 1), each with `text` as its text
 * layer.
 */
export function tinyPdf(text: string, pages = 1): Uint8Array {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  // 1 catalog, 2 page tree, 3 content stream, 4 font, then one object per page.
  const pageIds = Array.from({ length: pages }, (_, i) => i + 5);
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pageIds.map(
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 144] /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >> >>",
    ),
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
