import { describe, expect, it, vi } from "vitest";
import { tinyPdf } from "../../../test/fixtures/pdf";

// What extract.ts hands pdf-parse for an untrusted file: checked on the real constructor call.
const h = vi.hoisted(() => ({ options: [] as Record<string, unknown>[], destroyed: 0 }));
vi.mock("pdf-parse/worker", () => ({}));
vi.mock("pdf-parse", () => ({
  PDFParse: class {
    constructor(options: Record<string, unknown>) {
      h.options.push(options);
    }
    async getText() {
      return { text: "Total 5", total: 1 };
    }
    async destroy() {
      h.destroyed += 1;
    }
  },
}));

const { extractInvoice } = await import("./extract");

describe("extractInvoice and pdfjs", () => {
  it("opens a PDF without eval, stopping at errors, without fonts and with bounded images", async () => {
    const pdf = tinyPdf("Total 5");
    expect(await extractInvoice({ bytes: pdf, mediaType: "application/pdf" })).toEqual({
      text: "Total 5",
      truncated: null,
    });
    expect(h.options).toHaveLength(1);
    expect(h.options[0]).toMatchObject({
      isEvalSupported: false,
      stopAtErrors: true,
      disableFontFace: true,
      maxImageSize: expect.any(Number),
    });
    // A copy of the bytes, never the caller's buffer (pdfjs may detach it).
    expect(h.options[0]?.data).not.toBe(pdf);
    expect(h.destroyed).toBe(1);
  });
});
