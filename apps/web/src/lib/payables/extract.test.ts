import { describe, expect, it } from "vitest";
import { tinyPdf } from "../../../test/fixtures/pdf";
import {
  ExtractError,
  extractInvoice,
  extractText,
  MAX_INVOICE_BYTES,
  MAX_PDF_PAGES,
  MAX_TEXT_CHARS,
} from "./extract";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("extractText", () => {
  it("decodes plain text", async () => {
    expect(await extractText({ bytes: utf8("Total 25 USDC"), mediaType: "text/plain" })).toBe(
      "Total 25 USDC",
    );
  });

  it("reads text out of a PDF", async () => {
    const text = await extractText({
      bytes: tinyPdf("Invoice INV-7 Total 25.00 USDC"),
      mediaType: "application/pdf",
    });
    expect(text).toContain("INV-7");
    expect(text).toContain("25.00");
  });

  it("rejects empty, oversized and fake PDFs", async () => {
    await expect(
      extractText({ bytes: new Uint8Array(), mediaType: "text/plain" }),
    ).rejects.toBeInstanceOf(ExtractError);
    await expect(
      extractText({ bytes: new Uint8Array(MAX_INVOICE_BYTES + 1), mediaType: "text/plain" }),
    ).rejects.toBeInstanceOf(ExtractError);
    await expect(
      extractText({ bytes: utf8("hello"), mediaType: "application/pdf" }),
    ).rejects.toBeInstanceOf(ExtractError);
  });

  it("refuses text that is not UTF-8 instead of guessing at it", async () => {
    await expect(
      extractText({ bytes: new Uint8Array([0x54, 0x6f, 0xff, 0xfe]), mediaType: "text/plain" }),
    ).rejects.toThrow(/UTF-8/);
  });

  it("refuses a media type it cannot read", async () => {
    await expect(
      extractText({ bytes: utf8("x"), mediaType: "image/png" as "text/plain" }),
    ).rejects.toThrow(/PDF or plain text/);
  });

  it("drops NUL characters, which Postgres jsonb cannot hold", async () => {
    expect(await extractText({ bytes: utf8("Total\u0000 5"), mediaType: "text/plain" })).toBe(
      "Total 5",
    );
  });

  it("cuts long text without splitting a surrogate pair", async () => {
    const long = `${"a".repeat(MAX_TEXT_CHARS - 1)}\u{1F600}tail`;
    const text = await extractText({ bytes: utf8(long), mediaType: "text/plain" });
    expect(text).toBe("a".repeat(MAX_TEXT_CHARS - 1));
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    // The same text twice gives the same cut, so the invoice hash is stable.
    expect(await extractText({ bytes: utf8(long), mediaType: "text/plain" })).toBe(text);
  });

  it("turns CRLF into LF, so the model and the hash see one text however it was saved", async () => {
    const crlf = await extractText({
      bytes: utf8("Invoice 1\r\nTotal 5\r\n"),
      mediaType: "text/plain",
    });
    expect(crlf).toBe("Invoice 1\nTotal 5\n");
    expect(crlf).toBe(
      await extractText({ bytes: utf8("Invoice 1\nTotal 5\n"), mediaType: "text/plain" }),
    );
  });

  it("says when the text is not the whole invoice", async () => {
    expect(await extractInvoice({ bytes: utf8("Total 5"), mediaType: "text/plain" })).toEqual({
      text: "Total 5",
      truncated: null,
    });
    const long = await extractInvoice({
      bytes: utf8(`Total 5\n${"x".repeat(MAX_TEXT_CHARS)}`),
      mediaType: "text/plain",
    });
    expect(long.truncated).toBe("chars");
    const fits = await extractInvoice({
      bytes: tinyPdf("Total 5", MAX_PDF_PAGES),
      mediaType: "application/pdf",
    });
    expect(fits.truncated).toBeNull();
    const more = await extractInvoice({
      bytes: tinyPdf("Total 5", MAX_PDF_PAGES + 1),
      mediaType: "application/pdf",
    });
    expect(more.truncated).toBe("pages");
  });

  it("gives up on a PDF that takes too long to read, and destroys its parser", async () => {
    let destroyed = 0;
    const stuck = () => ({
      getText: () => new Promise<never>(() => {}), // never answers
      destroy: async () => {
        destroyed += 1;
      },
    });
    await expect(
      extractInvoice(
        { bytes: tinyPdf("Total 5"), mediaType: "application/pdf" },
        { pdfTimeoutMs: 20, makeParser: stuck },
      ),
    ).rejects.toThrow(/took longer than/);
    expect(destroyed).toBeGreaterThanOrEqual(1);
    // A later file still reads with the real parser.
    expect(
      await extractText({ bytes: tinyPdf("Invoice INV-8"), mediaType: "application/pdf" }),
    ).toContain("INV-8");
  });
});
