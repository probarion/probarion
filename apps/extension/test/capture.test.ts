import { describe, expect, it } from "vitest";
import {
  captureFile,
  captureSelection,
  captureUrl,
  cleanName,
  fromBase64,
  isPdfBytes,
  isPdfUrl,
  LINK_ELSEWHERE,
  MAX_FILE_BYTES,
  MAX_SELECTION_BYTES,
  MAX_TEXT_CHARS,
  NOT_INVOICE,
  NOT_UTF8,
  readCaptured,
  sameOrigin,
  TOO_LARGE,
  TOO_LONG,
  toBase64,
  toBlob,
} from "../src/capture";
import { fetchOf, PDF } from "./helpers";

const file = (bytes: Uint8Array, name: string, type = "") =>
  new File([bytes as Uint8Array<ArrayBuffer>], name, { type });

describe("what counts as an invoice", () => {
  it("tells a PDF address by its path", () => {
    expect(isPdfUrl("https://billing.example/a/Invoice-1042.PDF")).toBe(true);
    expect(isPdfUrl("https://billing.example/a.pdf?download=1")).toBe(true);
    expect(isPdfUrl("https://billing.example/invoices/1042")).toBe(false);
    expect(isPdfUrl("file:///C:/Users/me/invoice.pdf")).toBe(false);
    expect(isPdfUrl("chrome://newtab/")).toBe(false);
    expect(isPdfUrl("not a url")).toBe(false);
    expect(isPdfUrl(undefined)).toBe(false);
  });

  it("tells a PDF by its first bytes", () => {
    expect(isPdfBytes(PDF)).toBe(true);
    expect(isPdfBytes(new TextEncoder().encode("<html>"))).toBe(false);
    expect(isPdfBytes(new Uint8Array(0))).toBe(false);
  });

  it("compares origins, and an unreadable address matches nothing", () => {
    expect(sameOrigin("https://a.example/x.pdf", "https://a.example/page")).toBe(true);
    expect(sameOrigin("https://a.example/x.pdf", "https://b.example/page")).toBe(false);
    expect(sameOrigin("https://a.example/x.pdf", undefined)).toBe(false);
    expect(sameOrigin("data:application/pdf,x", "data:text/html,y")).toBe(false);
  });

  it("keeps a file name printable and short", () => {
    expect(cleanName("C:\\Users\\me\\Invoice 1042.pdf", "invoice.pdf")).toBe("Invoice 1042.pdf");
    expect(cleanName("evil\u202Efdp.exe", "invoice.pdf")).toBe("evilfdp.exe");
    expect(cleanName("", "invoice.pdf")).toBe("invoice.pdf");
    expect(cleanName("a".repeat(300), "x")).toHaveLength(100);
    // A 100-character cut never leaves half of a surrogate pair behind.
    expect(cleanName(`${"a".repeat(99)}😀`, "x")).toBe("a".repeat(99));
  });
});

describe("a selection", () => {
  it("becomes selection.txt with its first 80 characters as the preview", () => {
    const r = captureSelection("  Invoice INV-1042\nTotal due: 120.00 USDC  ");
    expect(r).toMatchObject({
      ok: true,
      item: {
        name: "selection.txt",
        type: "text/plain",
        preview: "Invoice INV-1042 Total due: 120.00 USDC",
      },
    });
    if (r.ok) expect(new TextDecoder().decode(fromBase64(r.item.base64))).toContain("Total due");
  });

  it("is refused when empty or over 64 KiB", () => {
    expect(captureSelection("   ")).toEqual({ ok: false, text: "Select the invoice text first." });
    expect(captureSelection("é".repeat(MAX_SELECTION_BYTES / 2)).ok).toBe(true);
    expect(captureSelection("a".repeat(MAX_SELECTION_BYTES + 1))).toEqual({
      ok: false,
      text: "The selection is over 64 KiB. Save it as a .txt file and choose it here.",
    });
  });

  it("refuses text Probarion would refuse: over 50,000 characters, or not UTF-8", async () => {
    expect(captureSelection("a".repeat(MAX_TEXT_CHARS)).ok).toBe(true);
    expect(captureSelection("a".repeat(MAX_TEXT_CHARS + 1))).toEqual({ ok: false, text: TOO_LONG });
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(await captureFile(file(enc("a".repeat(MAX_TEXT_CHARS + 1)), "a.txt"))).toEqual({
      ok: false,
      text: TOO_LONG,
    });
    expect(await captureFile(file(enc(`${"a\r\n".repeat(24_999)}ab`), "a.txt"))).toMatchObject({
      ok: true,
    });
    expect(await captureFile(file(new Uint8Array([0xff, 0xfe, 0x41, 0x00]), "a.txt"))).toEqual({
      ok: false,
      text: NOT_UTF8,
    });
  });
});

describe("a chosen or dropped file", () => {
  it("takes a PDF and a .txt", async () => {
    expect(await captureFile(file(PDF, "invoice.pdf", "application/pdf"))).toMatchObject({
      ok: true,
      item: { name: "invoice.pdf", type: "application/pdf", size: PDF.length, preview: null },
    });
    const txt = await captureFile(file(new TextEncoder().encode("Total 5 USDC"), "a.txt"));
    expect(txt).toMatchObject({ ok: true, item: { type: "text/plain", name: "a.txt" } });
  });

  it("refuses another type, a PDF that isn't one, an empty file and one over 4 MiB", async () => {
    expect(await captureFile(file(PDF, "invoice.docx"))).toEqual({ ok: false, text: NOT_INVOICE });
    expect(await captureFile(file(new TextEncoder().encode("hello"), "x.pdf"))).toEqual({
      ok: false,
      text: "This file isn't a PDF.",
    });
    expect(await captureFile(file(new Uint8Array(0), "x.pdf"))).toEqual({
      ok: false,
      text: "This file is empty.",
    });
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    big.set(PDF);
    expect(await captureFile(file(big, "big.pdf"))).toEqual({ ok: false, text: TOO_LARGE });
  });
});

describe("a PDF behind an address", () => {
  it("is fetched with the person's cookies for that site", async () => {
    const f = fetchOf(() => new Response(PDF, { headers: { "content-type": "application/pdf" } }));
    const r = await captureUrl("https://billing.example/files/Invoice%201042.pdf", f.fetch);
    expect(r).toMatchObject({
      ok: true,
      item: { name: "Invoice 1042.pdf", type: "application/pdf" },
    });
    expect(f.calls[0]?.init?.credentials).toBe("include");
  });

  /** A Response as fetch hands it after a redirect: its address is the final one. */
  const redirected = (to: string, init: ResponseInit = {}) => {
    const res = new Response(PDF, init);
    Object.defineProperty(res, "url", { value: to });
    Object.defineProperty(res, "redirected", { value: true });
    return res;
  };
  const asPdf = { headers: { "content-type": "application/pdf" } };

  it.each([
    ["another site", "https://probarion.xyz/console/acme.vault.testnet/payables/x.pdf"],
    ["another address of the same site", "https://cdn.billing.example/files/7.pdf"],
    ["the same host on another scheme", "http://billing.example/files/7.pdf"],
    ["no address at all", ""],
  ])("refuses a file a redirect brought from %s", async (_name, to) => {
    const f = fetchOf(() => redirected(to, asPdf));
    expect(await captureUrl("https://billing.example/files/7.pdf", f.fetch)).toEqual({
      ok: false,
      text: LINK_ELSEWHERE,
    });
  });

  it("takes a file a redirect brought from another path of the same site", async () => {
    const f = fetchOf(() => redirected("https://billing.example/store/7.pdf", asPdf));
    expect(await captureUrl("https://billing.example/files/7.pdf", f.fetch)).toMatchObject({
      ok: true,
      item: { name: "7.pdf", type: "application/pdf" },
    });
  });

  it("is read by its bytes, whatever the server calls it", async () => {
    const f = fetchOf(
      () => new Response(PDF, { headers: { "content-type": "application/octet-stream" } }),
    );
    expect((await captureUrl("https://billing.example/download?id=7", f.fetch)).ok).toBe(true);
  });

  it("says why it can't be read", async () => {
    const page = fetchOf(
      () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    );
    expect(await captureUrl("https://billing.example/x.pdf", page.fetch)).toEqual({
      ok: false,
      text: "This link isn't a PDF or a text file.",
    });
    const missing = fetchOf(() => new Response("no", { status: 404 }));
    expect(await captureUrl("https://billing.example/x.pdf", missing.fetch)).toEqual({
      ok: false,
      text: "Couldn't read this file (HTTP 404). Download it and drag it here.",
    });
    const down = fetchOf(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await captureUrl("https://billing.example/x.pdf", down.fetch)).toEqual({
      ok: false,
      text: LINK_ELSEWHERE,
    });
    expect(await captureUrl("javascript:alert(1)", down.fetch)).toEqual({
      ok: false,
      text: LINK_ELSEWHERE,
    });
    expect(down.calls).toHaveLength(1);
  });

  it("says why a link can't be read when its download breaks off", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.error(new TypeError("network reset"));
      },
    });
    const f = fetchOf(
      () => new Response(broken, { headers: { "content-type": "application/pdf" } }),
    );
    expect(await captureUrl("https://billing.example/x.pdf", f.fetch)).toEqual({
      ok: false,
      text: LINK_ELSEWHERE,
    });
  });

  it("stops at 4 MiB, from the declared length or while reading", async () => {
    const declared = fetchOf(
      () => new Response(PDF, { headers: { "content-length": String(MAX_FILE_BYTES + 1) } }),
    );
    expect(await captureUrl("https://billing.example/x.pdf", declared.fetch)).toEqual({
      ok: false,
      text: TOO_LARGE,
    });
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const streaming = fetchOf(() => new Response(endless));
    expect(await captureUrl("https://billing.example/x.pdf", streaming.fetch)).toEqual({
      ok: false,
      text: TOO_LARGE,
    });
    expect(pulled).toBeLessThan(8);
  });
});

describe("a captured invoice", () => {
  it("goes back to the same bytes and type as a Blob", async () => {
    const r = await captureFile(file(PDF, "invoice.pdf"));
    if (!r.ok) throw new Error(r.text);
    const blob = toBlob(r.item);
    expect(blob.type).toBe("application/pdf");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PDF);
    expect(fromBase64(toBase64(PDF))).toEqual(PDF);
  });

  it("is read back from storage only when it has the shape this version writes", () => {
    const item = {
      name: "a.pdf",
      type: "application/pdf",
      size: 5,
      base64: "JVBERi0=",
      preview: null,
    };
    expect(readCaptured(item)).toEqual(item);
    expect(readCaptured({ ...item, type: "text/html" })).toBeNull();
    expect(readCaptured({ ...item, size: MAX_FILE_BYTES + 1 })).toBeNull();
    expect(readCaptured({ ...item, base64: "not base64!" })).toBeNull();
    expect(readCaptured(null)).toBeNull();
  });
});
