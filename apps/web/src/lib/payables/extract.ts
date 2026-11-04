import "pdf-parse/worker"; // must load before pdf-parse on Node/Vercel (pdf-parse troubleshooting doc)
import { PDFParse } from "pdf-parse";
import { normaliseLineEnds } from "./amount";

/**
 * The largest invoice file read. The route caps the whole request at this plus 64 KiB for the form, which stays
 * under Vercel's 4.5 MB body cap.
 */
export const MAX_INVOICE_BYTES = 4 * 1024 * 1024;
/** The text the model is shown is at most this many UTF-16 units; the invoice hash is the hash of exactly that text. */
export const MAX_TEXT_CHARS = 50_000;
/** An invoice is a few pages: anything past this is not read (and not hashed), and the amount is refused. */
export const MAX_PDF_PAGES = 20;
/**
 * How long extractInvoice waits for pdf-parse before it refuses the PDF. This timeout guards only against a hung
 * promise: a parse that waits forever (on its worker, on a stream) is given up and torn down. It cannot pre-empt a
 * CPU-bound parse: the timer's callback runs only when the event loop is free, so a long synchronous step of
 * pdfjs (decoding a large stream, laying out a costly page) runs to its end first. The real bounds on a crafted
 * PDF are the input caps, MAX_INVOICE_BYTES (4 MiB) and MAX_PDF_PAGES (20; only those pages are read), and the
 * route's `maxDuration` (60 s), after which the platform ends the invocation. A worker thread that could be
 * terminated mid-parse is out of scope.
 */
export const PDF_TIMEOUT_MS = 20_000;

export type InvoiceMediaType = "application/pdf" | "text/plain";

/**
 * Why the text is not the whole invoice: `pages`, a PDF with more than MAX_PDF_PAGES pages (only those were
 * read); `chars`, text cut at MAX_TEXT_CHARS. Its total cannot be trusted, so the amount is refused.
 */
export type Truncation = "pages" | "chars";

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

/**
 * The text as the model will see it, and the hash is taken of exactly this text, and the amount reader reads it.
 * Every line end (CRLF, CR, VT, FF, NEL, LS, PS) becomes LF, so all three see the same lines however the file was
 * saved. A NUL becomes U+FFFD: Postgres jsonb cannot hold U+0000 (the ledger is jsonb), and deleting it would join
 * the characters on either side ("2<NUL>5" would read as 25); the amount reader refuses a text holding U+FFFD. A
 * cut at MAX_TEXT_CHARS never splits a surrogate pair, so the text always has a well-formed UTF-8 encoding and the
 * same input always gives the same text, hence the same invoice hash.
 */
function asModelText(raw: string): { text: string; cut: boolean } {
  const text = normaliseLineEnds(raw).replaceAll("\u0000", "\ufffd");
  if (text.length <= MAX_TEXT_CHARS) return { text, cut: false };
  const last = text.charCodeAt(MAX_TEXT_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_TEXT_CHARS - 1 : MAX_TEXT_CHARS;
  return { text: text.slice(0, end), cut: true };
}

/** pdfjs options for an untrusted file: no eval, stop at the first error, no fonts loaded, bounded images. */
const SAFE_PDF = {
  isEvalSupported: false,
  stopAtErrors: true,
  disableFontFace: true,
  maxImageSize: 16 * 1024 * 1024, // pixels; only the text layer is read
} as const;

/** What extractInvoice needs from pdf-parse's `PDFParse` (a test passes a fake one). */
export interface PdfParser {
  getText(p: { first: number }): Promise<{ text: string; total: number }>;
  destroy(): Promise<void>;
}

const newParser = (data: Uint8Array): PdfParser => new PDFParse({ data, ...SAFE_PDF });

async function pdfText(
  bytes: Uint8Array,
  timeoutMs: number,
  makeParser: (data: Uint8Array) => PdfParser,
): Promise<{ raw: string; pages: number }> {
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new ExtractError("Not a PDF file");
  }
  const parser = makeParser(new Uint8Array(bytes)); // copy: pdfjs may detach the buffer
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new ExtractError(`Reading the PDF took longer than ${Math.round(timeoutMs / 1000)} s`),
      );
    }, timeoutMs);
  });
  try {
    const r = await Promise.race([parser.getText({ first: MAX_PDF_PAGES }), timedOut]);
    return { raw: r.text, pages: r.total };
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    throw new ExtractError(
      `Could not read the PDF: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`,
    );
  } finally {
    // Runs as soon as the race settles, timed out or not: the parser and its worker are torn down at once.
    clearTimeout(timer);
    await parser.destroy().catch(() => {});
  }
}

/**
 * The text of an invoice file: UTF-8 text, or the text layer of a PDF (a scanned PDF without one gives empty
 * text, which the pipeline answers with `empty`), and whether it was cut short. Anything else is an
 * ExtractError, whose message is safe to show the uploader.
 */
export async function extractInvoice(
  u: { bytes: Uint8Array; mediaType: InvoiceMediaType },
  opts: { pdfTimeoutMs?: number; makeParser?: (data: Uint8Array) => PdfParser } = {},
): Promise<{ text: string; truncated: Truncation | null }> {
  if (u.bytes.length === 0) throw new ExtractError("The file is empty");
  if (u.bytes.length > MAX_INVOICE_BYTES) throw new ExtractError("The file is larger than 4 MiB");
  if (u.mediaType === "text/plain") {
    let raw: string;
    try {
      // Fatal: a file that is not UTF-8 is refused, never read with replacement characters.
      raw = new TextDecoder("utf-8", { fatal: true }).decode(u.bytes);
    } catch {
      throw new ExtractError("The text file is not UTF-8 text");
    }
    const { text, cut } = asModelText(raw);
    return { text, truncated: cut ? "chars" : null };
  }
  if (u.mediaType === "application/pdf") {
    const { raw, pages } = await pdfText(
      u.bytes,
      opts.pdfTimeoutMs ?? PDF_TIMEOUT_MS,
      opts.makeParser ?? newParser,
    );
    const { text, cut } = asModelText(raw);
    return { text, truncated: pages > MAX_PDF_PAGES ? "pages" : cut ? "chars" : null };
  }
  throw new ExtractError("Only PDF or plain text invoices are supported");
}

/** The text only (see extractInvoice). */
export async function extractText(u: {
  bytes: Uint8Array;
  mediaType: InvoiceMediaType;
}): Promise<string> {
  return (await extractInvoice(u)).text;
}
