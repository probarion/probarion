import { describe, expect, it } from "vitest";
import { tinyPdf } from "../../../test/fixtures/pdf";
import { ExtractError, extractText, MAX_INVOICE_BYTES, MAX_TEXT_CHARS } from "./extract";

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
});
