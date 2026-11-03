import "pdf-parse/worker"; // must load before pdf-parse on Node/Vercel (pdf-parse troubleshooting doc)
import { PDFParse } from "pdf-parse";

export const MAX_INVOICE_BYTES = 4 * 1024 * 1024; // below Vercel's 4.5 MB request cap
/** The text the model is shown is at most this many UTF-16 units; the invoice hash is the hash of exactly that text. */
export const MAX_TEXT_CHARS = 50_000;
/** An invoice is a few pages: anything past this is not read (and not hashed). */
export const MAX_PDF_PAGES = 20;

export type InvoiceMediaType = "application/pdf" | "text/plain";

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

/**
 * The text as the model will see it. NUL characters go (Postgres jsonb cannot hold U+0000, and the ledger is
 * jsonb), and a cut at MAX_TEXT_CHARS never splits a surrogate pair, so the text always has a well-formed
 * UTF-8 encoding and the same input always gives the same text, hence the same invoice hash.
 */
function asModelText(raw: string): string {
  const text = raw.replaceAll("\u0000", "");
  if (text.length <= MAX_TEXT_CHARS) return text;
  const cut = text.charCodeAt(MAX_TEXT_CHARS - 1);
  const end = cut >= 0xd800 && cut <= 0xdbff ? MAX_TEXT_CHARS - 1 : MAX_TEXT_CHARS;
  return text.slice(0, end);
}

/**
 * The text of an invoice file: UTF-8 text as it is, or the text layer of a PDF (a scanned PDF without one
 * gives empty text, which the pipeline answers with `empty`). Anything else is an ExtractError, whose message
 * is safe to show the uploader.
 */
export async function extractText(u: {
  bytes: Uint8Array;
  mediaType: InvoiceMediaType;
}): Promise<string> {
  if (u.bytes.length === 0) throw new ExtractError("The file is empty");
  if (u.bytes.length > MAX_INVOICE_BYTES) throw new ExtractError("The file is larger than 4 MB");
  if (u.mediaType === "text/plain") {
    try {
      // Fatal: a file that is not UTF-8 is refused, never read with replacement characters.
      return asModelText(new TextDecoder("utf-8", { fatal: true }).decode(u.bytes));
    } catch {
      throw new ExtractError("The text file is not UTF-8 text");
    }
  }
  if (u.mediaType === "application/pdf") {
    if (new TextDecoder().decode(u.bytes.slice(0, 5)) !== "%PDF-") {
      throw new ExtractError("Not a PDF file");
    }
    const parser = new PDFParse({ data: new Uint8Array(u.bytes) }); // copy: pdfjs may detach the buffer
    try {
      return asModelText((await parser.getText({ first: MAX_PDF_PAGES })).text);
    } catch (e) {
      throw new ExtractError(
        `Could not read the PDF: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`,
      );
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  throw new ExtractError("Only PDF or plain text invoices are supported");
}
